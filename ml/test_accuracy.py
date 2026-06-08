"""
AlohaScan — test de PRECIZIE & CALIBRARE ML pe meciuri reale.

Ia ultimele 2000 meciuri cu rezultat din predictions (cele mai RECENTE — pe care
modelul le-a „văzut" cel mai puțin la antrenare), citește features din ml_features,
aplică modelul LR din ml/model_export.json EXACT ca api/ml-predict.js (standardizare
+ feature lipsă → media scaler-ului + sigmoid) și compară cu rezultatele reale.

Pentru fiecare piață (Over 1.5/2.5, BTTS, Home Win, Away Win):
  • Brier score   • Acuratețe la prag 50%   • Calibrare pe bucket-uri de 10%.

⚠ READ-ONLY pe DB. NU atinge scoring-ul (calcConfidence*/score1-7). Conexiune din
   variabile de mediu / .env (nu hardcodăm parola).

Rulare:  python3 ml/test_accuracy.py
"""

import os
import json
import math
import numpy as np
import pandas as pd
import psycopg2

ML_DIR = os.path.dirname(os.path.abspath(__file__))
EXPORT_PATH = os.path.join(ML_DIR, "model_export.json")
N_MATCHES = 2000


def _load_env_file(path="/root/scannerv2/.env"):
    # Încarcă manual KEY=VALUE din .env (fără python-dotenv). Doar cheile absente.
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
    _load_env_file()
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


# Ultimele N meciuri cu rezultat: features (predictions + ml_features + referee) + labels.
QUERY = f"""
SELECT
    p.fixture_id,
    p.score1, p.score2, p.score3, p.score6, p.score7,
    p.home_win_prob, p.draw_prob, p.away_win_prob,
    p.over15_prob, p.over25_prob, p.gg_prob,
    p.lambda_home, p.lambda_away,
    p.home_elo, p.away_elo, p.elo_diff_ml, p.home_win_prob_elo,
    p.home_position_norm, p.away_position_norm, p.confidence,
    mlf.home_sot_avg, mlf.away_sot_avg,
    mlf.home_corners_avg, mlf.away_corners_avg,
    mlf.home_xg_avg, mlf.away_xg_avg,
    mlf.home_yc_avg, mlf.away_yc_avg,
    mlf.home_rc_avg, mlf.away_rc_avg,
    mlf.home_fouls_avg, mlf.away_fouls_avg,
    mlf.home_insidebox_avg, mlf.away_insidebox_avg,
    mlf.home_possession_avg, mlf.away_possession_avg,
    mlf.home_goals_r1_avg, mlf.away_goals_r1_avg,
    mlf.home_goals_r2_avg, mlf.away_goals_r2_avg,
    mlf.home_subs_avg, mlf.away_subs_avg,
    rs.pct_over_25 AS ref_pct_over25,
    CASE WHEN rs.referee_style = 'open' THEN 1 ELSE 0 END AS ref_style_open,
    fh.home_goals, fh.away_goals, p.result_winner,
    fh.match_date
FROM predictions p
JOIN fixtures_history fh ON fh.fixture_id = p.fixture_id
LEFT JOIN ml_features mlf ON mlf.fixture_id = p.fixture_id
LEFT JOIN referee_stats rs ON rs.referee_name = fh.referee
WHERE p.result_winner IS NOT NULL
  AND p.score1 IS NOT NULL
  AND fh.home_goals IS NOT NULL
ORDER BY fh.match_date DESC
LIMIT {N_MATCHES}
"""

# nume afișat → (cheie în model_export.json, funcție label din rândul df)
MARKETS = [
    ("Over 1.5", "over15_total", lambda d: ((d["home_goals"] + d["away_goals"]) >= 2).astype(int)),
    ("Over 2.5", "over25_total", lambda d: ((d["home_goals"] + d["away_goals"]) >= 3).astype(int)),
    ("BTTS",     "btts_total",   lambda d: ((d["home_goals"] > 0) & (d["away_goals"] > 0)).astype(int)),
    ("Home Win", "home_win",     lambda d: (d["result_winner"] == "home").astype(int)),
    ("Away Win", "away_win",     lambda d: (d["result_winner"] == "away").astype(int)),
]


def lr_predict(model, df):
    """Probabilitate LR EXACT ca api/ml-predict.js lrProb: standardizare cu
    scaler_mean/scale, feature lipsă (NaN) → media (z=0, neutru), apoi sigmoid.
    Vectorizat pe toate rândurile. Întoarce array 0..1."""
    feats = model["features"]
    coef = model["lr_coef"]
    mean = model["scaler_mean"]
    scale = model["scaler_scale"]
    logit = np.full(len(df), float(model["lr_intercept"]), dtype=float)
    for i, fn in enumerate(feats):
        m = float(mean[i])
        sc = float(scale[i]) or 1.0
        if fn in df.columns:
            col = pd.to_numeric(df[fn], errors="coerce").fillna(m).to_numpy(dtype=float)
        else:
            col = np.full(len(df), m, dtype=float)  # feature absent → neutru
        logit += float(coef[i]) * ((col - m) / sc)
    logit = np.clip(logit, -30, 30)
    return 1.0 / (1.0 + np.exp(-logit))


def report_market(name, model, df):
    p = lr_predict(model, df)                       # 0..1
    y = MARKETS_LABEL[name](df).to_numpy(dtype=int)  # 0/1
    n = len(y)
    brier = float(np.mean((p - y) ** 2))
    acc = float(np.mean((p >= 0.5).astype(int) == y)) * 100
    base = float(np.mean(y)) * 100

    print(f"\n=== {name} ===")
    print(f"Brier: {brier:.4f} | Acuratețe: {acc:.1f}% | Base rate: {base:.1f}% | N={n}")
    print("Calibrare:")
    for b in range(10):
        lo, hi = b / 10.0, (b + 1) / 10.0
        mask = (p >= lo) & (p < hi) if b < 9 else (p >= lo) & (p <= 1.0)
        cnt = int(mask.sum())
        if cnt == 0:
            continue
        real = float(np.mean(y[mask])) * 100
        mid = (lo + hi) / 2 * 100
        flag = "✅" if abs(real - mid) <= 10 else "⚠️"
        print(f"  {int(lo*100):>2}-{int(hi*100):>3}%: {cnt:>5} predicții → {real:5.1f}% real {flag}")


MARKETS_LABEL = {name: fn for name, _, fn in MARKETS}


def main():
    if not os.path.exists(EXPORT_PATH):
        print(f"⚠ Lipsește {EXPORT_PATH} — antrenează întâi (python3 ml/train_model.py).")
        return
    with open(EXPORT_PATH) as f:
        models = json.load(f)

    conn = get_conn()
    df = pd.read_sql(QUERY, conn)
    conn.close()
    print(f"Meciuri testate (cele mai recente cu rezultat): {len(df)}")
    if len(df) < 50:
        print("⚠ Prea puține meciuri pentru un test relevant.")
        return

    # Coerce numeric + features derivate (identic cu train_model.py).
    for c in ["lambda_home", "lambda_away", "home_elo", "away_elo", "home_goals", "away_goals"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["lambda_sum"] = df["lambda_home"].fillna(0) + df["lambda_away"].fillna(0)
    df["lambda_ratio"] = df["lambda_home"].fillna(0) / df["lambda_away"].replace(0, 1).fillna(1)
    df["elo_sum"] = df["home_elo"].fillna(1500) + df["away_elo"].fillna(1500)

    for name, key, _ in MARKETS:
        m = models.get(key)
        if not m or "lr_coef" not in m:
            print(f"\n=== {name} ===\n  Piață lipsă din model_export.json ({key}) — skip.")
            continue
        report_market(name, m, df)

    print("\nNotă: calibrare bună = % real ≈ mijlocul bucket-ului (±10pp = ✅).")
    print("Dacă predicțiile cu 70-80% se întâmplă ~75% din cazuri → model onest, NU trișează.")


if __name__ == "__main__":
    main()
