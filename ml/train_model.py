"""
AlohaScan — Antrenare model ML complet (pre-meci + repriza 1 + repriza 2).

Citește din `predictions` (features pre-meci) + `fixtures_history` (scor final/HT)
+ `match_events` (HT calculat fallback) + `match_stats` (statistici totale), apoi
antrenează LogisticRegression + GradientBoosting pe MULTE piețe (total / HT / R2),
raportează Brier vs modelul actual și exportă totul în ml/model_export.json.

⚠ SECURITATE: conexiunea DB se ia din VARIABILE DE MEDIU (nu hardcodăm parola):
     export POSTGRES_URL="postgresql://alohascan:***@127.0.0.1:5432/elefant"
   sau  export PGPASSWORD=*** PGUSER=alohascan PGDATABASE=elefant PGHOST=127.0.0.1

⚠ SCHEMA: match_stats e WIDE per-echipă (fixture_id, team_id, shots_on_goal,
   shots_total, corner_kicks, ball_possession, ...) — NU EAV (is_home/stat_type/value).
   match_events are team_id (echipa care a marcat). Query-ul de mai jos respectă
   schema REALĂ (join pe team_id față de fixtures_history.home/away_team_id).

Rulare:  pip install -r ml/requirements.txt  &&  python ml/train_model.py
"""

import os
import sys
import json
import numpy as np
import pandas as pd
import psycopg2
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import brier_score_loss, accuracy_score
from sklearn.preprocessing import StandardScaler
import joblib

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


# PASUL 1 — Query extins (adaptat la schema REALĂ: match_stats wide, match_events team_id)
QUERY = """
SELECT
    p.fixture_id,
    p.score1, p.score2, p.score3, p.score6, p.score7,
    p.home_win_prob, p.draw_prob, p.away_win_prob,
    p.over15_prob, p.over25_prob, p.gg_prob,
    p.lambda_home, p.lambda_away,
    p.home_elo, p.away_elo, p.elo_diff_ml,
    p.home_win_prob_elo,
    p.home_position_norm, p.away_position_norm,
    p.confidence,
    p.result_winner, p.result_over15, p.result_over25, p.result_gg,
    fh.home_goals, fh.away_goals,
    fh.home_ht, fh.away_ht,
    fh.match_date, fh.home_team_id, fh.away_team_id, fh.referee,
    COALESCE(fh.home_ht, ht.home_ht_calc) AS home_ht_final,
    COALESCE(fh.away_ht, ht.away_ht_calc) AS away_ht_final,
    ms_home.shots_total     AS shots_home,
    ms_home.shots_on_goal   AS shots_on_target_home,
    ms_home.corner_kicks    AS corners_home,
    ms_home.ball_possession AS possession_home,
    ms_away.shots_total     AS shots_away,
    ms_away.shots_on_goal   AS shots_on_target_away,
    ms_away.corner_kicks    AS corners_away,
    ms_away.ball_possession AS possession_away,
    -- Medii istorice MATERIALIZATE (ml_features, rolling 100, point-in-time).
    -- Sursă canonică de calcul: api/cron/build-ml-features.js (aceleași LATERAL).
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
    rs.pct_over_25  AS ref_pct_over25,
    CASE WHEN rs.referee_style = 'open' THEN 1 ELSE 0 END AS ref_style_open,
    p.created_at
FROM predictions p
JOIN fixtures_history fh ON fh.fixture_id = p.fixture_id
LEFT JOIN (
    SELECT me.fixture_id,
        SUM(CASE
            WHEN me.elapsed <= 45 AND me.team_id = fh2.home_team_id AND me.detail IS DISTINCT FROM 'Own Goal' THEN 1
            WHEN me.elapsed <= 45 AND me.team_id = fh2.away_team_id AND me.detail = 'Own Goal' THEN 1
            ELSE 0 END) AS home_ht_calc,
        SUM(CASE
            WHEN me.elapsed <= 45 AND me.team_id = fh2.away_team_id AND me.detail IS DISTINCT FROM 'Own Goal' THEN 1
            WHEN me.elapsed <= 45 AND me.team_id = fh2.home_team_id AND me.detail = 'Own Goal' THEN 1
            ELSE 0 END) AS away_ht_calc
    FROM match_events me
    JOIN fixtures_history fh2 ON fh2.fixture_id = me.fixture_id
    WHERE me.type = 'Goal'
    GROUP BY me.fixture_id
) ht ON ht.fixture_id = p.fixture_id
LEFT JOIN match_stats ms_home ON ms_home.fixture_id = p.fixture_id AND ms_home.team_id = fh.home_team_id
LEFT JOIN match_stats ms_away ON ms_away.fixture_id = p.fixture_id AND ms_away.team_id = fh.away_team_id
-- Medii istorice MATERIALIZATE (rolling 100, point-in-time) — calculate O DATĂ de
-- api/cron/build-ml-features.js. Înlocuiește 4 LATERAL grele → antrenare instant.
-- Lipsă rând → coloane NULL → fillna(median) mai jos.
LEFT JOIN ml_features mlf ON mlf.fixture_id = p.fixture_id
LEFT JOIN referee_stats rs ON rs.referee_name = fh.referee
WHERE p.result_winner IS NOT NULL
  AND p.score1 IS NOT NULL
  AND fh.home_goals IS NOT NULL
ORDER BY p.created_at ASC
"""

FEATURES_PREMATCH = [
    "score1", "score2", "score3", "score6", "score7",
    "home_win_prob", "draw_prob", "away_win_prob",
    "over15_prob", "over25_prob", "gg_prob",
    "lambda_home", "lambda_away", "lambda_sum", "lambda_ratio",
    "home_elo", "away_elo", "elo_diff_ml", "home_win_prob_elo", "elo_sum",
    "home_position_norm", "away_position_norm",
    "confidence",
    # Medii ISTORICE (ultimele 10 meciuri anterioare) din match_stats + arbitru.
    # Pre-meci, fără lookahead (match_date < meciul curent). FEATURES_HT le
    # moștenește automat (sunt valide și pentru R2). NULL → fillna median.
    "home_sot_avg", "away_sot_avg",
    "home_corners_avg", "away_corners_avg",
    "home_xg_avg", "away_xg_avg",
    "home_yc_avg", "away_yc_avg",
    "home_rc_avg", "away_rc_avg",
    "home_fouls_avg", "away_fouls_avg",
    "ref_pct_over25", "ref_style_open",
    # Features noi (rolling 100): insidebox/posesie medii + goluri R1/R2 + substituiri.
    "home_insidebox_avg", "away_insidebox_avg",
    "home_possession_avg", "away_possession_avg",
    "home_goals_r1_avg", "away_goals_r1_avg",
    "home_goals_r2_avg", "away_goals_r2_avg",
    "home_subs_avg", "away_subs_avg",
]
# ⚠ ANTI-LEAKAGE: goals_*_current / goal_diff_current NU mai sunt în PREMATCH —
# la antrenare valorau scorul FINAL → determinau direct label-ul (Brier 0.0000
# fals pe over/1X2). elapsed_norm / minutes_remaining eliminate (constante la
# meci terminat → varianță zero, inutile). goals_*_current rămân DOAR în
# FEATURES_HT (piețele r2_*), recalculate ca scorul la PAUZĂ — cunoscut CORECT
# înainte de repriza 2, deci NON-leaky pentru R2.
FEATURES_HT = FEATURES_PREMATCH + [
    "home_ht", "away_ht", "goals_ht",
    "shots_home", "shots_away",
    "shots_on_target_home", "shots_on_target_away",
    "corners_home", "corners_away",
    "possession_home", "possession_away",
    "goals_home_current", "goals_away_current", "goal_diff_current",
]

MARKETS = {
    "over05_total": ("y_over05", FEATURES_PREMATCH, "Over 0.5 Total"),
    "over15_total": ("y_over15", FEATURES_PREMATCH, "Over 1.5 Total"),
    "over25_total": ("y_over25", FEATURES_PREMATCH, "Over 2.5 Total"),
    "over35_total": ("y_over35", FEATURES_PREMATCH, "Over 3.5 Total"),
    "over45_total": ("y_over45", FEATURES_PREMATCH, "Over 4.5 Total"),
    "btts_total":   ("y_btts",   FEATURES_PREMATCH, "BTTS Total"),
    "over05_home":  ("y_over05_home", FEATURES_PREMATCH, "Over 0.5 Home"),
    "over05_away":  ("y_over05_away", FEATURES_PREMATCH, "Over 0.5 Away"),
    "home_win":     ("y_home_win", FEATURES_PREMATCH, "Home Win"),
    "draw":         ("y_draw",     FEATURES_PREMATCH, "Draw"),
    "away_win":     ("y_away_win", FEATURES_PREMATCH, "Away Win"),
    # Repriza 1 (pre-meci features)
    "ht_over05": ("y_ht_over05", FEATURES_PREMATCH, "HT Over 0.5"),
    "ht_over15": ("y_ht_over15", FEATURES_PREMATCH, "HT Over 1.5"),
    "ht_over25": ("y_ht_over25", FEATURES_PREMATCH, "HT Over 2.5"),
    "ht_btts":   ("y_ht_btts",   FEATURES_PREMATCH, "HT BTTS"),
    "ht_home":   ("y_ht_home",   FEATURES_PREMATCH, "HT Home Score"),
    "ht_away":   ("y_ht_away",   FEATURES_PREMATCH, "HT Away Score"),
    "ht_home_over15": ("y_ht_home_over15", FEATURES_PREMATCH, "HT Gazde Over 1.5"),
    "ht_home_over25": ("y_ht_home_over25", FEATURES_PREMATCH, "HT Gazde Over 2.5"),
    "ht_away_over15": ("y_ht_away_over15", FEATURES_PREMATCH, "HT Oaspeți Over 1.5"),
    "ht_away_over25": ("y_ht_away_over25", FEATURES_PREMATCH, "HT Oaspeți Over 2.5"),
    # Repriza 2 (pre-meci + HT features)
    "r2_over05": ("y_r2_over05", FEATURES_HT, "R2 Over 0.5"),
    "r2_over15": ("y_r2_over15", FEATURES_HT, "R2 Over 1.5"),
    "r2_over25": ("y_r2_over25", FEATURES_HT, "R2 Over 2.5"),
    "r2_btts":   ("y_r2_btts",   FEATURES_HT, "R2 BTTS"),
    "r2_home":   ("y_r2_home",   FEATURES_HT, "R2 Home Score"),
    "r2_away":   ("y_r2_away",   FEATURES_HT, "R2 Away Score"),
    "r2_home_over15": ("y_r2_home_over15", FEATURES_HT, "R2 Gazde Over 1.5"),
    "r2_home_over25": ("y_r2_home_over25", FEATURES_HT, "R2 Gazde Over 2.5"),
    "r2_away_over15": ("y_r2_away_over15", FEATURES_HT, "R2 Oaspeți Over 1.5"),
    "r2_away_over25": ("y_r2_away_over25", FEATURES_HT, "R2 Oaspeți Over 2.5"),
    "r2_home_win": ("y_r2_home_win", FEATURES_HT, "R2 Gazde câștigă"),
    "r2_draw":     ("y_r2_draw",     FEATURES_HT, "R2 Egal"),
    "r2_away_win": ("y_r2_away_win", FEATURES_HT, "R2 Oaspeți câștigă"),
}

ACTUAL_COL = {"y_over15": "over15_prob", "y_over25": "over25_prob",
              "y_btts": "gg_prob", "y_home_win": "home_win_prob"}


def main():
    conn = get_conn()
    df = pd.read_sql(QUERY, conn)
    conn.close()
    print(f"Date extrase: {len(df)} predicții")
    if len(df) < 200:
        print("⚠ Prea puține date pentru antrenare (recomandat 2000+). Ies.")
        return

    # Temporal weight — predicțiile recente cântăresc mai mult (tz-aware UTC).
    df["days_old"] = (pd.Timestamp.now(tz="UTC") - pd.to_datetime(df["created_at"], utc=True)).dt.days
    df["sample_weight"] = np.exp(-0.001 * df["days_old"])

    # PASUL 2 — features derivate (scor HT + R2 + pre-meci)
    for c in ["home_goals", "away_goals", "home_ht_final", "away_ht_final",
              "lambda_home", "lambda_away", "home_elo", "away_elo",
              "shots_home", "shots_away", "shots_on_target_home", "shots_on_target_away",
              "corners_home", "corners_away", "possession_home", "possession_away"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    # Features istorice noi (match_stats medii + arbitru): coerce + fillna median.
    _new_feats = [
        "home_sot_avg", "away_sot_avg", "home_corners_avg", "away_corners_avg",
        "home_xg_avg", "away_xg_avg", "home_yc_avg", "away_yc_avg",
        "home_rc_avg", "away_rc_avg", "home_fouls_avg", "away_fouls_avg",
        "ref_pct_over25", "ref_style_open",
        "home_insidebox_avg", "away_insidebox_avg",
        "home_possession_avg", "away_possession_avg",
        "home_goals_r1_avg", "away_goals_r1_avg",
        "home_goals_r2_avg", "away_goals_r2_avg",
        "home_subs_avg", "away_subs_avg",
    ]
    for c in _new_feats:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df[_new_feats] = df[_new_feats].fillna(df[_new_feats].median())

    df["home_ht"] = df["home_ht_final"].fillna(0)
    df["away_ht"] = df["away_ht_final"].fillna(0)
    df["goals_ht"] = df["home_ht"] + df["away_ht"]
    df["home_r2"] = df["home_goals"] - df["home_ht"]
    df["away_r2"] = df["away_goals"] - df["away_ht"]
    df["goals_r2"] = df["home_r2"] + df["away_r2"]
    df["lambda_sum"] = df["lambda_home"].fillna(0) + df["lambda_away"].fillna(0)
    df["lambda_ratio"] = df["lambda_home"].fillna(0) / df["lambda_away"].replace(0, 1).fillna(1)
    df["elo_sum"] = df["home_elo"].fillna(1500) + df["away_elo"].fillna(1500)

    # Scor „curent" pentru piețele R2 = scorul la PAUZĂ (home_ht/away_ht),
    # cunoscut CORECT înainte de repriza 2 → NU scorul final (ANTI-LEAKAGE).
    # Folosit DOAR de FEATURES_HT (r2_*); pre-meci/HT nu le mai folosesc.
    # elapsed_norm / minutes_remaining eliminate (constante → varianță zero).
    df["goals_home_current"] = df["home_ht"]
    df["goals_away_current"] = df["away_ht"]
    df["goal_diff_current"] = df["home_ht"] - df["away_ht"]

    # Probabilitățile modelului actual pot lipsi pe unele predicții → fillna(50)
    # ca brier_actual (comparația cu modelul curent) să nu primească NaN.
    for _pc in ["home_win_prob", "over15_prob", "over25_prob", "gg_prob"]:
        df[_pc] = pd.to_numeric(df[_pc], errors="coerce").fillna(50)

    # PASUL 3 — labels toate piețele
    df["y_over05"] = (df["home_goals"] + df["away_goals"] >= 1).astype(int)
    df["y_over15"] = (df["home_goals"] + df["away_goals"] >= 2).astype(int)
    df["y_over25"] = (df["home_goals"] + df["away_goals"] >= 3).astype(int)
    df["y_over35"] = (df["home_goals"] + df["away_goals"] >= 4).astype(int)
    df["y_over45"] = (df["home_goals"] + df["away_goals"] >= 5).astype(int)
    df["y_btts"]   = ((df["home_goals"] > 0) & (df["away_goals"] > 0)).astype(int)
    df["y_over05_home"] = (df["home_goals"] >= 1).astype(int)
    df["y_over05_away"] = (df["away_goals"] >= 1).astype(int)
    df["y_home_win"] = (df["result_winner"] == "home").astype(int)
    df["y_draw"]     = (df["result_winner"] == "draw").astype(int)
    df["y_away_win"] = (df["result_winner"] == "away").astype(int)
    df["y_ht_over05"] = (df["goals_ht"] >= 1).astype(int)
    df["y_ht_over15"] = (df["goals_ht"] >= 2).astype(int)
    df["y_ht_over25"] = (df["goals_ht"] >= 3).astype(int)
    df["y_ht_btts"]   = ((df["home_ht"] > 0) & (df["away_ht"] > 0)).astype(int)
    df["y_ht_home"]   = (df["home_ht"] >= 1).astype(int)
    df["y_ht_away"]   = (df["away_ht"] >= 1).astype(int)
    df["y_ht_home_over15"] = (df["home_ht"] >= 2).astype(int)
    df["y_ht_home_over25"] = (df["home_ht"] >= 3).astype(int)
    df["y_ht_away_over15"] = (df["away_ht"] >= 2).astype(int)
    df["y_ht_away_over25"] = (df["away_ht"] >= 3).astype(int)
    df["y_r2_over05"] = (df["goals_r2"] >= 1).astype(int)
    df["y_r2_over15"] = (df["goals_r2"] >= 2).astype(int)
    df["y_r2_over25"] = (df["goals_r2"] >= 3).astype(int)
    df["y_r2_btts"]   = ((df["home_r2"] > 0) & (df["away_r2"] > 0)).astype(int)
    df["y_r2_home"]   = (df["home_r2"] >= 1).astype(int)
    df["y_r2_away"]   = (df["away_r2"] >= 1).astype(int)
    df["y_r2_home_over15"] = (df["home_r2"] >= 2).astype(int)
    df["y_r2_home_over25"] = (df["home_r2"] >= 3).astype(int)
    df["y_r2_away_over15"] = (df["away_r2"] >= 2).astype(int)
    df["y_r2_away_over25"] = (df["away_r2"] >= 3).astype(int)
    df["y_r2_home_win"] = (df["home_r2"] > df["away_r2"]).astype(int)
    df["y_r2_draw"]     = (df["home_r2"] == df["away_r2"]).astype(int)
    df["y_r2_away_win"] = (df["away_r2"] > df["home_r2"]).astype(int)

    # PASUL 5 — antrenează modele. Cu argumente CLI → DOAR piețele cerute (merge
    # în model_export.json, nu suprascrie tot). Fără argumente → toate (ca înainte).
    selected = [a for a in sys.argv[1:] if not a.startswith("-")]
    if selected:
        unknown = [k for k in selected if k not in MARKETS]
        if unknown:
            print("⚠ Piețe necunoscute (ignorate):", ", ".join(unknown))
        selected = [k for k in selected if k in MARKETS]
        if not selected:
            print("Nicio piață validă în argumente. Ies.")
            return
        print("Antrenez DOAR:", ", ".join(selected))
    markets_to_train = MARKETS if not selected else {k: MARKETS[k] for k in selected}

    results = {}
    for market_key, (label_col, features, desc) in markets_to_train.items():
        print(f"\n=== {desc} ===")
        mask = df[label_col].notna()
        # fillna median apoi 0 (în caz de coloană complet goală → fără crash sklearn)
        X = df.loc[mask, features].fillna(df[features].median()).fillna(0)
        y = df.loc[mask, label_col].astype(int)
        w = df.loc[mask, "sample_weight"]

        if len(y) < 100 or y.nunique() < 2:
            print(f"  Date insuficiente: {len(y)} rânduri (sau o singură clasă)")
            continue

        # Split TEMPORAL: df e sortat cronologic (QUERY ORDER BY created_at ASC),
        # deci ultimele 20% = cele mai recente meciuri → estimare Brier ONESTĂ
        # (fără scurgere din viitor ca la split-ul random anterior).
        split_idx = int(len(y) * 0.8)
        X_train, X_test = X.iloc[:split_idx], X.iloc[split_idx:]
        y_train, y_test = y.iloc[:split_idx], y.iloc[split_idx:]
        w_train, w_test = w.iloc[:split_idx], w.iloc[split_idx:]
        if y_train.nunique() < 2 or len(y_test) < 1:
            print("  Skip: o singură clasă în train după split temporal")
            continue

        scaler = StandardScaler()
        X_train_s = scaler.fit_transform(X_train)
        X_test_s = scaler.transform(X_test)

        # class_weight='balanced' — compensează dezechilibrul de clasă (ex. over05/
        # over15 ~95% DA) ca modelul să nu prezică leneș doar clasa majoritară.
        lr = LogisticRegression(class_weight="balanced", C=1.0, max_iter=1000, random_state=42)
        lr.fit(X_train_s, y_train, sample_weight=w_train)

        gb = GradientBoostingClassifier(n_estimators=200, max_depth=4,
                                        learning_rate=0.05, random_state=42)
        gb.fit(X_train, y_train, sample_weight=w_train)

        brier_lr = brier_score_loss(y_test, lr.predict_proba(X_test_s)[:, 1], sample_weight=w_test)
        brier_gb = brier_score_loss(y_test, gb.predict_proba(X_test)[:, 1], sample_weight=w_test)

        actual_col = ACTUAL_COL.get(label_col)
        brier_actual = None
        if actual_col:
            brier_actual = brier_score_loss(y_test, df.loc[X_test.index, actual_col] / 100.0)

        # Base rate + Brier baseline (a prezice mereu media). brier_lr >= baseline
        # ⇒ modelul NU aduce skill peste „prezice rata medie".
        base_rate = float(y_test.mean())
        brier_baseline = base_rate * (1 - base_rate)
        line = (f"  N={len(y)} | Base rate: {base_rate:.3f} | "
                f"Brier baseline: {brier_baseline:.4f} | LR: {brier_lr:.4f} | GB: {brier_gb:.4f}")
        if brier_lr >= brier_baseline:
            line += " | ⚠ LR NU bate baseline"
        if brier_actual is not None:
            line += f" | Actual: {brier_actual:.4f} | {'✅ ML CÂȘTIGĂ' if brier_gb < brier_actual else '❌ Model actual mai bun'}"
        print(line)

        fi = pd.DataFrame({"feature": features, "importance": gb.feature_importances_})
        fi = fi.sort_values("importance", ascending=False).head(5)
        print(f"  Top features: {', '.join(fi['feature'].tolist())}")

        results[market_key] = {
            "description": desc,
            "n_samples": int(len(y)),
            "base_rate": base_rate,
            "brier_baseline": float(brier_baseline),
            "brier_lr": float(brier_lr),
            "brier_gb": float(brier_gb),
            "brier_actual": float(brier_actual) if brier_actual is not None else None,
            "ml_wins": bool(brier_gb < brier_actual) if brier_actual is not None else None,
            "features": features,
            "lr_coef": lr.coef_[0].tolist(),
            "lr_intercept": float(lr.intercept_[0]),
            "scaler_mean": scaler.mean_.tolist(),
            "scaler_scale": scaler.scale_.tolist(),
            "feature_importances": dict(zip(features, gb.feature_importances_.tolist())),
        }

        joblib.dump(gb, os.path.join(ML_DIR, f"model_gb_{market_key}.pkl"))
        joblib.dump(scaler, os.path.join(ML_DIR, f"scaler_{market_key}.pkl"))

    export_path = os.path.join(ML_DIR, "model_export.json")
    # Antrenare parțială (cu argumente) → MERGE cu exportul existent (păstrează
    # celelalte piețe). Antrenare completă → suprascrie tot (comportament actual).
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
    print(f"✅ Export ({len(final)} piețe total) în ml/model_export.json")


if __name__ == "__main__":
    main()
