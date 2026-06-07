"""
AlohaScan — Antrenare model ML pe predicțiile istorice.

Citește din tabela `predictions` (features score1-7 + ELO + poziție clasament +
probabilități + labels rezolvate), antrenează Logistic Regression + Gradient
Boosting pentru Home Win, raportează Brier vs modelul actual, exportă coeficienții
LR ca JSON pentru consum în Node.js.

⚠ SECURITATE: conexiunea DB se ia din VARIABILE DE MEDIU (nu hardcodăm parola).
   Setează POSTGRES_URL, sau PGPASSWORD/PGUSER/PGDATABASE/PGHOST înainte de rulare:
     export POSTGRES_URL="postgresql://alohascan:***@127.0.0.1:5432/elefant"
   sau
     export PGPASSWORD=*** PGUSER=alohascan PGDATABASE=elefant PGHOST=127.0.0.1

Rulare:  pip install -r ml/requirements.txt  &&  python ml/train_model.py
"""

import os
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


# ── PASUL 2 — Conectare la DB (din mediu, FĂRĂ parolă hardcodată) ──────────────
def get_conn():
    url = os.getenv("POSTGRES_URL")
    if url:
        return psycopg2.connect(url)
    return psycopg2.connect(
        dbname=os.getenv("PGDATABASE", "elefant"),
        user=os.getenv("PGUSER", "alohascan"),
        password=os.getenv("PGPASSWORD"),   # din mediu — nu în cod
        host=os.getenv("PGHOST", "127.0.0.1"),
        port=os.getenv("PGPORT", "5432"),
    )


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
    p.created_at,
    COALESCE(p.lambda_home, 0) + COALESCE(p.lambda_away, 0) AS lambda_sum,
    CASE WHEN COALESCE(p.lambda_away, 0) > 0
         THEN COALESCE(p.lambda_home, 0) / p.lambda_away
         ELSE 1 END AS lambda_ratio,
    CASE WHEN p.home_elo IS NOT NULL AND p.away_elo IS NOT NULL
         THEN p.home_elo + p.away_elo
         ELSE NULL END AS elo_sum
FROM predictions p
WHERE p.result_winner IS NOT NULL
  AND p.home_elo IS NOT NULL
  AND p.score1 IS NOT NULL
  AND p.score2 IS NOT NULL
ORDER BY p.created_at ASC
"""

FEATURES_WIN = [
    "score1", "score2", "score3", "score6", "score7",
    "home_win_prob", "draw_prob", "away_win_prob",
    "lambda_home", "lambda_away", "lambda_sum", "lambda_ratio",
    "home_elo", "away_elo", "elo_diff_ml", "home_win_prob_elo", "elo_sum",
    "home_position_norm", "away_position_norm",
    "confidence",
]


def main():
    conn = get_conn()
    df = pd.read_sql(QUERY, conn)
    print(f"Date extrase: {len(df)} predicții")
    if len(df) < 200:
        print("⚠ Prea puține date pentru antrenare (recomandat 2000+). Ies.")
        conn.close()
        return

    # ── PASUL 3 — Pregătire features ──────────────────────────────────────────
    df["days_old"] = (pd.Timestamp.now(tz='UTC') - pd.to_datetime(df["created_at"], utc=True)).dt.days
    df["sample_weight"] = np.exp(-0.001 * df["days_old"])

    for col in FEATURES_WIN:
        df[col] = pd.to_numeric(df[col], errors="coerce")
        med = df[col].median()
        df[col] = df[col].fillna(med if pd.notna(med) else 0)

    y_win = (df["result_winner"] == "home").astype(int)
    X = df[FEATURES_WIN]
    weights = df["sample_weight"]

    # ── PASUL 4 — Antrenare (80/20) ───────────────────────────────────────────
    X_train, X_test, y_train, y_test, w_train, w_test, idx_train, idx_test = train_test_split(
        X, y_win, weights, df.index, test_size=0.2, random_state=42
    )

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    lr = LogisticRegression(max_iter=1000, random_state=42)
    lr.fit(X_train_scaled, y_train, sample_weight=w_train)

    gb = GradientBoostingClassifier(
        n_estimators=200, max_depth=4, learning_rate=0.05, random_state=42
    )
    gb.fit(X_train, y_train, sample_weight=w_train)

    # ── PASUL 5 — Validare Brier ──────────────────────────────────────────────
    brier_lr = brier_score_loss(y_test, lr.predict_proba(X_test_scaled)[:, 1], sample_weight=w_test)
    brier_gb = brier_score_loss(y_test, gb.predict_proba(X_test)[:, 1], sample_weight=w_test)
    brier_actual = brier_score_loss(y_test, df.loc[idx_test, "home_win_prob"] / 100.0)

    print("\n=== REZULTATE HOME WIN ===")
    print("Logistic Regression:")
    print(f"  Brier: {brier_lr:.4f}")
    print(f"  Accuracy: {accuracy_score(y_test, lr.predict(X_test_scaled)):.4f}")
    print("Gradient Boosting:")
    print(f"  Brier: {brier_gb:.4f}")
    print(f"  Accuracy: {accuracy_score(y_test, gb.predict(X_test)):.4f}")
    print(f"Model actual (home_win_prob): Brier {brier_actual:.4f}")

    feature_importance = pd.DataFrame({
        "feature": FEATURES_WIN,
        "importance": gb.feature_importances_,
    }).sort_values("importance", ascending=False)
    print("\n=== IMPORTANȚA FEATURES ===")
    print(feature_importance.to_string(index=False))

    # ── PASUL 6 — Salvare modele + ponderi ────────────────────────────────────
    joblib.dump(lr, os.path.join(ML_DIR, "model_lr_win.pkl"))
    joblib.dump(gb, os.path.join(ML_DIR, "model_gb_win.pkl"))
    joblib.dump(scaler, os.path.join(ML_DIR, "scaler_win.pkl"))

    weights_json = {
        "features": FEATURES_WIN,
        "coefficients": lr.coef_[0].tolist(),
        "intercept": float(lr.intercept_[0]),
        "scaler_mean": scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        "brier_lr": float(brier_lr),
        "brier_gb": float(brier_gb),
        "brier_actual": float(brier_actual),
        "trained_on": int(len(df)),
        "trained_at": pd.Timestamp.now().isoformat(),
    }
    with open(os.path.join(ML_DIR, "model_weights.json"), "w") as f:
        json.dump(weights_json, f, indent=2)

    print("\n✅ Modele salvate în ml/ (model_lr_win.pkl, model_gb_win.pkl, scaler_win.pkl)")
    print("✅ Ponderi exportate în ml/model_weights.json")
    conn.close()


if __name__ == "__main__":
    main()
