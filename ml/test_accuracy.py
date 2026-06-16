"""
AlohaScan — test de PRECIZIE & CALIBRARE ML pe meciuri reale.

Ia ultimele 2000 meciuri cu rezultat din predictions (cele mai RECENTE — pe care
modelul le-a „văzut" cel mai puțin la antrenare), citește features din ml_features,
aplică modelul LR din ml/model_export.json EXACT ca api/ml-predict.js (standardizare
+ feature lipsă → media scaler-ului + sigmoid) ȘI stratul de calibrare din
ml/calibration_export.json (replică EXACTĂ a applyCalibPct din api/ml-predict.js),
apoi compară cu rezultatele reale.

Pentru fiecare piață afișează DOUĂ coloane — „LR brut" și „Calibrat" — cu:
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
CALIB_PATH = os.path.join(ML_DIR, "calibration_export.json")
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
# fh.home_ht / fh.away_ht sunt necesare pt piețele 1H / 2H (derivare scor pe reprize).
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
    fh.home_goals, fh.away_goals, fh.home_ht, fh.away_ht, p.result_winner,
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


# Etichete (label) — outcome real derivat din date deja existente.
def _lbl_over15(d):  return ((d["home_goals"] + d["away_goals"]) >= 2).astype(int)
def _lbl_over25(d):  return ((d["home_goals"] + d["away_goals"]) >= 3).astype(int)
def _lbl_btts(d):    return ((d["home_goals"] > 0) & (d["away_goals"] > 0)).astype(int)
def _lbl_home_win(d): return (d["result_winner"] == "home").astype(int)
def _lbl_away_win(d): return (d["result_winner"] == "away").astype(int)
# Piețe noi prioritare:
def _lbl_home_scores(d): return (d["home_goals"] > 0).astype(int)
def _lbl_away_scores(d): return (d["away_goals"] > 0).astype(int)
def _lbl_1h_over05(d):   return ((d["home_ht"] + d["away_ht"]) >= 1).astype(int)
def _lbl_1h_over15(d):   return ((d["home_ht"] + d["away_ht"]) >= 2).astype(int)
def _lbl_2h_over05(d):   return (((d["home_goals"] - d["home_ht"]) + (d["away_goals"] - d["away_ht"])) >= 1).astype(int)
def _lbl_2h_over15(d):   return (((d["home_goals"] - d["home_ht"]) + (d["away_goals"] - d["away_ht"])) >= 2).astype(int)

# (nume afișat, cheie în model_export.json / calibration_export.json, label_fn, requires_ht)
# Cheile sunt EXACT cele din ml/train_model.py MARKETS (sursa exportului).
MARKETS = [
    ("Over 1.5",               "over15_total", _lbl_over15,     False),
    ("Over 2.5",               "over25_total", _lbl_over25,     False),
    ("BTTS",                   "btts_total",   _lbl_btts,       False),
    ("Home Win",               "home_win",     _lbl_home_win,   False),
    ("Away Win",               "away_win",     _lbl_away_win,   False),
    # ── piețe noi prioritare ──
    ("Gazde marchează (1+)",   "over05_home",  _lbl_home_scores, False),
    ("Oaspeți marchează (1+)", "over05_away",  _lbl_away_scores, False),
    ("1H Over 0.5",            "ht_over05",    _lbl_1h_over05,  True),
    ("1H Over 1.5",            "ht_over15",    _lbl_1h_over15,  True),
    ("2H Over 0.5",            "r2_over05",    _lbl_2h_over05,  True),
    ("2H Over 1.5",            "r2_over15",    _lbl_2h_over15,  True),
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


def calibrate_p(table, key, p_arr):
    """Replică EXACT api/ml-predict.js applyCalibPct, vectorizat pe array 0..1.
    table[key] = {calibrated:true, x:[0..1], y:[0..1]}. Necalibrat/lipsă/<2 pct
    → identitate. Interpolare liniară (endpoint-clamp), clamp [0.01,0.99], apoi
    rotunjire la procent întreg (Math.round(cal*100)) exact ca în serving."""
    e = table.get(key) if isinstance(table, dict) else None
    if (not e or not e.get("calibrated")
            or not isinstance(e.get("x"), list) or not isinstance(e.get("y"), list)
            or len(e["x"]) < 2):
        return p_arr  # identitate
    x = np.asarray(e["x"], dtype=float)
    y = np.asarray(e["y"], dtype=float)
    p = np.clip(p_arr, 0.0, 1.0)
    cal = np.interp(p, x, y)                 # p<=x[0]→y[0]; p>=x[-1]→y[-1] (ca applyCalibPct)
    cal = np.clip(cal, 0.01, 0.99)
    return np.round(cal * 100.0) / 100.0     # round la procent întreg ca ml-predict.js


def _is_calibrated(table, key):
    e = table.get(key) if isinstance(table, dict) else None
    return bool(e and e.get("calibrated")
                and isinstance(e.get("x"), list) and isinstance(e.get("y"), list)
                and len(e["x"]) >= 2)


def _metrics(p, y):
    brier = float(np.mean((p - y) ** 2))
    acc = float(np.mean((p >= 0.5).astype(int) == y)) * 100
    return brier, acc


def _calib_lines(p, y):
    """Linii de calibrare pe bucket-uri de 10% pt un set de probabilități."""
    out = []
    for b in range(10):
        lo, hi = b / 10.0, (b + 1) / 10.0
        mask = (p >= lo) & (p < hi) if b < 9 else (p >= lo) & (p <= 1.0)
        cnt = int(mask.sum())
        if cnt == 0:
            continue
        real = float(np.mean(y[mask])) * 100
        mid = (lo + hi) / 2 * 100
        flag = "✅" if abs(real - mid) <= 10 else "⚠️"
        out.append(f"  {int(lo*100):>2}-{int(hi*100):>3}%: {cnt:>5} predicții → {real:5.1f}% real {flag}")
    return out


def report_market(name, key, label_fn, requires_ht, model, table, df):
    # NULL handling: piețele 1H/2H folosesc DOAR rândurile cu home_ht ȘI away_ht non-NULL.
    if requires_ht:
        mask = df["home_ht"].notna() & df["away_ht"].notna()
        sub = df[mask]
        excluded = int((~mask).sum())
    else:
        sub = df
        excluded = 0

    print(f"\n=== {name} ===")
    if requires_ht:
        print(f"(HT necesar) excluse din lipsă de HT: {excluded} din {len(df)} → folosite: {len(sub)}")
    if len(sub) == 0:
        print("  0 rânduri valide — skip.")
        return

    p_raw = lr_predict(model, sub)             # 0..1
    p_cal = calibrate_p(table, key, p_raw)     # 0..1 (identitate dacă necalibrat)
    y = label_fn(sub).to_numpy(dtype=int)
    n = len(y)
    base = float(np.mean(y)) * 100
    calibrated = _is_calibrated(table, key)

    b_raw, a_raw = _metrics(p_raw, y)
    b_cal, a_cal = _metrics(p_cal, y)

    print(f"N={n} | Base rate: {base:.1f}% | calibrare: {'DA' if calibrated else 'identitate (lipsă/necalibrat)'}")
    print(f"{'':<10}{'Brier':>10}{'Acc@50%':>10}")
    print(f"{'LR brut:':<10}{b_raw:>10.4f}{a_raw:>9.1f}%")
    print(f"{'Calibrat:':<10}{b_cal:>10.4f}{a_cal:>9.1f}%")

    print("Calibrare LR brut:")
    for ln in _calib_lines(p_raw, y):
        print(ln)
    print("Calibrare Calibrat:")
    for ln in _calib_lines(p_cal, y):
        print(ln)


def main():
    if not os.path.exists(EXPORT_PATH):
        print(f"⚠ Lipsește {EXPORT_PATH} — antrenează întâi (python3 ml/train_model.py).")
        return
    with open(EXPORT_PATH) as f:
        models = json.load(f)

    # Stratul de calibrare (opțional). Lipsă → toate piețele rămân pe identitate.
    calib = {}
    if os.path.exists(CALIB_PATH):
        try:
            with open(CALIB_PATH) as f:
                calib = json.load(f) or {}
        except Exception as e:
            print(f"⚠ Nu pot citi {CALIB_PATH} ({e}) — calibrarea rămâne identitate.")
    else:
        print(f"⚠ Lipsește {CALIB_PATH} — coloana „Calibrat” = identitate (rulează ml/calibrate.py).")

    conn = get_conn()
    df = pd.read_sql(QUERY, conn)
    conn.close()
    print(f"Meciuri testate (cele mai recente cu rezultat): {len(df)}")
    if len(df) < 50:
        print("⚠ Prea puține meciuri pentru un test relevant.")
        return

    # Coerce numeric + features derivate (identic cu train_model.py).
    for c in ["lambda_home", "lambda_away", "home_elo", "away_elo",
              "home_goals", "away_goals", "home_ht", "away_ht"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["lambda_sum"] = df["lambda_home"].fillna(0) + df["lambda_away"].fillna(0)
    df["lambda_ratio"] = df["lambda_home"].fillna(0) / df["lambda_away"].replace(0, 1).fillna(1)
    df["elo_sum"] = df["home_elo"].fillna(1500) + df["away_elo"].fillna(1500)
    # Features FEATURES_HT derivate DOAR din scorul la pauză (ca în train_model.py),
    # pt piețele r2_* care folosesc FEATURES_HT. Restul (shots/corners/possession
    # din meciul curent) lipsesc → lr_predict le pune pe medie (neutru), identic
    # cu serving-ul. Unde HT lipsește, rămân NaN → rândul e oricum exclus la r2/ht.
    df["goals_ht"] = df["home_ht"] + df["away_ht"]
    df["goals_home_current"] = df["home_ht"]
    df["goals_away_current"] = df["away_ht"]
    df["goal_diff_current"] = df["home_ht"] - df["away_ht"]

    for name, key, label_fn, requires_ht in MARKETS:
        m = models.get(key)
        if not m or "lr_coef" not in m:
            print(f"\n=== {name} ===\n  Piață lipsă din model_export.json ({key}) — skip.")
            continue
        report_market(name, key, label_fn, requires_ht, m, calib, df)

    print("\nNotă: calibrare bună = % real ≈ mijlocul bucket-ului (±10pp = ✅).")
    print("Dacă predicțiile cu 70-80% se întâmplă ~75% din cazuri → model onest, NU trișează.")
    print("Coloana „Calibrat” arată efectul ml/calibration_export.json (identitate dacă lipsește).")


if __name__ == "__main__":
    main()
