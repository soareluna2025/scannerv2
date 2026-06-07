"""
AlohaScan — Antrenare modele ML LIVE pe prediction_log.

Spre deosebire de ml/train_model.py (snapshot final, features pre-meci), aici
fiecare rând din prediction_log = o predicție făcută LA UN MINUT REAL, cu
features live luate din live_stats la momentul predicției (LATERAL JOIN pe
elapsed <= minute). Labels = outcome WIN/LOSS (rezolvat din fixtures_history).

Antrenează 4 modele separate (NGP / OVER15 / GG / CONFIDENCE), cu split pe
fixture_id (GroupShuffleSplit) ca să nu existe leakage între snapshot-urile
aceluiași meci. Exportă coeficienții LR în ml/model_live_export.json (consumat
de api/ml-predict.js, la fel ca model_export.json).

⚠ SECURITATE: conexiunea DB se ia din VARIABILE DE MEDIU / .env (nu hardcodăm).
⚠ NU modifică train_model.py, calcConfidence*, score1-7.

Rulare:  pip install -r ml/requirements.txt  &&  python ml/train_live.py
         python ml/train_live.py live_ngp live_gg     # doar anumite modele (merge)
"""

import os
import sys
import json
import numpy as np
import pandas as pd
import psycopg2
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupShuffleSplit
from sklearn.metrics import brier_score_loss, accuracy_score
from sklearn.preprocessing import StandardScaler

ML_DIR = os.path.dirname(os.path.abspath(__file__))


def _load_env_file(path="/root/scannerv2/.env"):
    # Încarcă manual KEY=VALUE din .env (fără python-dotenv). Setează doar cheile
    # care NU există deja în environment → funcționează manual ȘI din cron/PM2.
    try:
        with open(path, "r") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
    except FileNotFoundError:
        pass
    except Exception:
        pass


def get_conn():
    _load_env_file()   # din .env dacă lipsesc din mediu (cron/PM2)
    url = os.getenv("POSTGRES_URL")
    if url:
        return psycopg2.connect(url)
    return psycopg2.connect(
        dbname=os.getenv("PGDATABASE", "elefant"),
        user=os.getenv("PGUSER", "alohascan"),
        password=os.getenv("PGPASSWORD"),
        host=os.getenv("PGHOST", "127.0.0.1"),
        port=os.getenv("PGPORT", "5432"),
    )


# Query principal — features live (snapshot la momentul predicției) + ELO.
QUERY = """
SELECT
    pl.fixture_id,
    pl.module,
    pl.minute,
    pl.predicted_value,
    pl.score_at_prediction,
    pl.layer1_score, pl.layer2_score, pl.layer3_score,
    pl.layer4_score, pl.layer5_score, pl.layer6_score, pl.layer7_score,
    pl.lambda_home, pl.lambda_away, pl.ngp_value,
    pl.outcome,
    pl.match_date,
    -- Features din live_stats la momentul predicției
    ls.home_goals, ls.away_goals,
    ls.home_sot, ls.away_sot,
    ls.home_shots, ls.away_shots,
    ls.home_possession, ls.away_possession,
    ls.home_corners, ls.away_corners,
    ls.home_da, ls.away_da,
    -- ELO
    COALESCE(p.home_elo, 1500) AS home_elo,
    COALESCE(p.away_elo, 1500) AS away_elo,
    COALESCE(p.elo_diff_ml, 0) AS elo_diff_ml
FROM prediction_log pl
LEFT JOIN LATERAL (
    SELECT * FROM live_stats ls2
    WHERE ls2.fixture_id = pl.fixture_id
      AND ls2.elapsed <= pl.minute
    ORDER BY ls2.elapsed DESC
    LIMIT 1
) ls ON true
LEFT JOIN predictions p ON p.fixture_id = pl.fixture_id
WHERE pl.outcome IN ('WIN', 'LOSS')
  AND pl.minute IS NOT NULL
  AND pl.minute BETWEEN 1 AND 89
ORDER BY pl.match_date ASC
"""

FEATURES = [
    "minute", "predicted_value", "ngp_value",
    "layer1_score", "layer2_score", "layer3_score",
    "layer4_score", "layer5_score", "layer6_score", "layer7_score",
    "lambda_home", "lambda_away",
    "home_goals", "away_goals",
    "home_sot", "away_sot",
    "home_shots", "away_shots",
    "home_possession", "away_possession",
    "home_corners", "away_corners",
    "home_da", "away_da",
    "home_elo", "away_elo", "elo_diff_ml",
    "elapsed_norm",        # minute/90
    "minutes_remaining",   # (90-minute)/90
    "goal_diff",           # home_goals - away_goals
    "total_goals_now",     # home_goals + away_goals
]

# market_key -> (modul în prediction_log, descriere)
MODELS = {
    "live_ngp":        ("NGP",        "NGP live prediction"),
    "live_over15":     ("OVER15",     "Over 1.5 live prediction"),
    "live_gg":         ("GG",         "BTTS (GG) live prediction"),
    "live_confidence": ("CONFIDENCE", "Confidence live prediction"),
}

# Coloane numerice de curățat (coerce + fillna).
_NUMERIC = [
    "minute", "predicted_value", "ngp_value",
    "layer1_score", "layer2_score", "layer3_score", "layer4_score",
    "layer5_score", "layer6_score", "layer7_score",
    "lambda_home", "lambda_away",
    "home_goals", "away_goals", "home_sot", "away_sot",
    "home_shots", "away_shots", "home_possession", "away_possession",
    "home_corners", "away_corners", "home_da", "away_da",
    "home_elo", "away_elo", "elo_diff_ml",
]


def main():
    conn = get_conn()
    df = pd.read_sql(QUERY, conn)
    conn.close()
    print(f"Date extrase: {len(df)} predicții (WIN/LOSS, minut 1-89)")
    if len(df) < 200:
        print("⚠ Prea puține date pentru antrenare. Ies.")
        return

    # Curățare numerică.
    for c in _NUMERIC:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    # Features derivate.
    hg = df["home_goals"].fillna(0)
    ag = df["away_goals"].fillna(0)
    df["elapsed_norm"] = df["minute"] / 90.0
    df["minutes_remaining"] = (90.0 - df["minute"]) / 90.0
    df["goal_diff"] = hg - ag
    df["total_goals_now"] = hg + ag

    # Label binar + temporal weight (predicțiile recente cântăresc mai mult).
    df["y"] = (df["outcome"] == "WIN").astype(int)
    df["days_old"] = (pd.Timestamp.now(tz="UTC") - pd.to_datetime(df["match_date"], utc=True)).dt.days
    df["days_old"] = df["days_old"].fillna(0).clip(lower=0)
    df["sample_weight"] = np.exp(-0.001 * df["days_old"])

    # Selecție modele (argumente CLI → doar acelea, merge în export; fără → toate).
    selected = [a for a in sys.argv[1:] if not a.startswith("-")]
    if selected:
        unknown = [k for k in selected if k not in MODELS]
        if unknown:
            print("⚠ Modele necunoscute (ignorate):", ", ".join(unknown))
        selected = [k for k in selected if k in MODELS]
        if not selected:
            print("Niciun model valid în argumente. Ies.")
            return
        print("Antrenez DOAR:", ", ".join(selected))
    models_to_train = MODELS if not selected else {k: MODELS[k] for k in selected}

    results = {}
    for market_key, (module, desc) in models_to_train.items():
        print(f"\n=== {desc}  (module={module}) ===")
        sub = df[df["module"] == module].copy()
        if len(sub) < 100 or sub["y"].nunique() < 2:
            print(f"  Date insuficiente: {len(sub)} rânduri (sau o singură clasă)")
            continue

        X = sub[FEATURES].fillna(sub[FEATURES].median()).fillna(0)
        y = sub["y"].astype(int)
        w = sub["sample_weight"]
        groups = sub["fixture_id"]

        # Split pe FIXTURE (anti-leakage: snapshot-urile aceluiași meci nu se
        # împart între train și test).
        gss = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=42)
        train_idx, test_idx = next(gss.split(X, y, groups))
        X_train, X_test = X.iloc[train_idx], X.iloc[test_idx]
        y_train, y_test = y.iloc[train_idx], y.iloc[test_idx]
        w_train, w_test = w.iloc[train_idx], w.iloc[test_idx]

        scaler = StandardScaler()
        X_train_s = scaler.fit_transform(X_train)
        X_test_s = scaler.transform(X_test)

        lr = LogisticRegression(max_iter=1000, random_state=42)
        lr.fit(X_train_s, y_train, sample_weight=w_train)

        proba = lr.predict_proba(X_test_s)[:, 1]
        brier_lr = brier_score_loss(y_test, proba, sample_weight=w_test)
        acc = accuracy_score(y_test, (proba >= 0.5).astype(int), sample_weight=w_test)
        win_rate = float(y.mean() * 100)

        # Top 5 features după |coef| (features standardizate → comparabile).
        coef = lr.coef_[0]
        order = np.argsort(np.abs(coef))[::-1][:5]
        top5 = [FEATURES[i] for i in order]
        print(f"  N={len(y)} (fixtures={groups.nunique()}) | "
              f"win_rate={win_rate:.1f}% | Brier LR: {brier_lr:.4f} | Acc: {acc:.3f}")
        print(f"  Top features: {', '.join(top5)}")

        results[market_key] = {
            "description": desc,
            "module": module,
            "n_samples": int(len(y)),
            "n_fixtures": int(groups.nunique()),
            "win_rate": win_rate,
            "brier_lr": float(brier_lr),
            "accuracy": float(acc),
            "top_features": top5,
            "features": FEATURES,
            "lr_coef": coef.tolist(),
            "lr_intercept": float(lr.intercept_[0]),
            "scaler_mean": scaler.mean_.tolist(),
            "scaler_scale": scaler.scale_.tolist(),
        }

    if not results:
        print("\n⚠ Niciun model antrenat (date insuficiente). Nu scriu exportul.")
        return

    # Antrenare parțială (cu argumente) → MERGE cu exportul existent; completă → suprascrie.
    export_path = os.path.join(ML_DIR, "model_live_export.json")
    final = {}
    if selected:
        try:
            with open(export_path) as f:
                final = json.load(f)
        except Exception:
            final = {}
    final.update(results)
    with open(export_path, "w") as f:
        json.dump(final, f, indent=2)
    print(f"\n✅ {len(results)} modele antrenate" + (" (merge)" if selected else ""))
    print(f"✅ Export ({len(final)} modele total) în ml/model_live_export.json")


if __name__ == "__main__":
    main()
