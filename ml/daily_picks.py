"""
AlohaScan — daily_picks.py — MOTOR DE SELECȚIE a ponturilor zilei (PROTOTIP).

READ-ONLY pe DB. NU atinge aplicația / scoring / calcConfidence* / score1-7.
model_export.json + calibration_export.json sunt DOAR citite. Conexiunea și
logica ML (încărcare model, lr_predict, calibrate_p) sunt REFOLOSITE din
ml/test_accuracy.py — nimic rescris de la zero.

Rankingul se face pe probabilitatea CALIBRATĂ (calibrate_p = replică applyCalibPct
din api/ml-predict.js). Doar piețe de încredere, validate calibrate:
    over15_total (Over 1.5) · over05_home (gazde marchează) · over05_away (oaspeți marchează)

MOD „AZI" (default):    python3 ml/daily_picks.py [--prag 0.88] [--conf-high 80] [--top 5]
MOD „BACKTEST":         python3 ml/daily_picks.py --backtest [--days 90] [--conf-high 80] [--top 5]

⚠ „confidence HIGH" = predictions.confidence >= --conf-high (default 80, exact pragul
  „Confidence ≥80" din UI / app-state.js). Nu există coloană textuală de tier; e numeric.
"""

import os
import json
import argparse
import numpy as np
import pandas as pd

# REFOLOSIRE din test_accuracy.py (NU rescriem): paths, conexiune, lr_predict, calibrate_p.
import test_accuracy as ta


# Piețe de ÎNCREDERE — chei EXACT ca în model_export.json / calibration_export.json
# (sursa = ml/train_model.py MARKETS). Fiecare cu funcția de outcome real (din goluri).
CONF_MARKETS = [
    ("Over 1.5",          "over15_total",
     lambda d: ((d["home_goals"] + d["away_goals"]) >= 2).astype(int)),
    ("Gazde marchează",   "over05_home",
     lambda d: (d["home_goals"] > 0).astype(int)),
    ("Oaspeți marchează", "over05_away",
     lambda d: (d["away_goals"] > 0).astype(int)),
]

# Coloanele de features (predictions + ml_features + referee) — IDENTICE cu cele din
# ml/test_accuracy.py QUERY; lr_predict le mapează după nume (lipsă → media scaler-ului).
_FEATURE_SELECT = """
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
    CASE WHEN rs.referee_style = 'open' THEN 1 ELSE 0 END AS ref_style_open
"""

# AZI: fixturile cu predicție din ziua curentă, toate ligile, ideal neîncepute.
QUERY_TODAY = f"""
SELECT
    p.fixture_id, p.home_team, p.away_team, p.league_name, p.match_date, p.confidence,
    fh.home_goals, fh.away_goals,
{_FEATURE_SELECT}
FROM predictions p
LEFT JOIN ml_features mlf ON mlf.fixture_id = p.fixture_id
LEFT JOIN fixtures_history fh ON fh.fixture_id = p.fixture_id
LEFT JOIN referee_stats rs ON rs.referee_name = (
    SELECT referee FROM fixtures_history WHERE fixture_id = p.fixture_id
)
WHERE p.score1 IS NOT NULL
  AND p.match_date >= date_trunc('day', NOW())
  AND p.match_date <  date_trunc('day', NOW()) + INTERVAL '1 day'
ORDER BY p.match_date ASC
"""

# BACKTEST: ultimele N zile, doar meciuri JUCATE (goluri cunoscute) pt outcome real.
QUERY_BACKTEST = f"""
SELECT
    p.fixture_id, p.home_team, p.away_team, p.league_name, p.match_date, p.confidence,
    fh.home_goals, fh.away_goals,
{_FEATURE_SELECT}
FROM predictions p
JOIN fixtures_history fh ON fh.fixture_id = p.fixture_id
LEFT JOIN ml_features mlf ON mlf.fixture_id = p.fixture_id
LEFT JOIN referee_stats rs ON rs.referee_name = fh.referee
WHERE p.score1 IS NOT NULL
  AND fh.home_goals IS NOT NULL AND fh.away_goals IS NOT NULL
  AND p.match_date >= NOW() - (%(days)s || ' days')::interval
  AND p.match_date <  NOW()
ORDER BY p.match_date ASC
"""


def _load_models_and_calib():
    if not os.path.exists(ta.EXPORT_PATH):
        raise SystemExit(f"⚠ Lipsește {ta.EXPORT_PATH} — antrenează (python3 ml/train_model.py).")
    with open(ta.EXPORT_PATH) as f:
        models = json.load(f)
    calib = {}
    if os.path.exists(ta.CALIB_PATH):
        try:
            with open(ta.CALIB_PATH) as f:
                calib = json.load(f) or {}
        except Exception as e:
            print(f"⚠ Nu pot citi {ta.CALIB_PATH} ({e}) — calibrarea = identitate.")
    else:
        print(f"⚠ Lipsește {ta.CALIB_PATH} — calibrarea = identitate (rulează ml/calibrate.py).")
    return models, calib


def _prep_features(df):
    """Coerce numeric + features derivate — IDENTIC cu ml/test_accuracy.py."""
    for c in ["lambda_home", "lambda_away", "home_elo", "away_elo",
              "home_goals", "away_goals", "confidence"]:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    df["lambda_sum"] = df["lambda_home"].fillna(0) + df["lambda_away"].fillna(0)
    df["lambda_ratio"] = df["lambda_home"].fillna(0) / df["lambda_away"].replace(0, 1).fillna(1)
    df["elo_sum"] = df["home_elo"].fillna(1500) + df["away_elo"].fillna(1500)
    return df


def _build_long(df, models, calib, with_outcome):
    """Tabel lung: un rând per (fixtură × piață de încredere) cu p_calibrat și
    (opțional) outcome real. p_calibrat din calibrate_p (=raw dacă necalibrat)."""
    rows = []
    for name, key, outcome_fn in CONF_MARKETS:
        m = models.get(key)
        if not m or "lr_coef" not in m:
            print(f"⚠ Piață lipsă din model_export.json: {key} — ignorată.")
            continue
        p_raw = ta.lr_predict(m, df)                  # 0..1
        p_cal = ta.calibrate_p(calib, key, p_raw)     # 0..1 (=raw dacă necalibrat)
        sub = pd.DataFrame({
            "fixture_id": df["fixture_id"].to_numpy(),
            "day": pd.to_datetime(df["match_date"]).dt.date.to_numpy(),
            "home_team": df["home_team"].to_numpy(),
            "away_team": df["away_team"].to_numpy(),
            "league_name": df["league_name"].to_numpy(),
            "confidence": pd.to_numeric(df["confidence"], errors="coerce").to_numpy(),
            "market": name,
            "market_key": key,
            "p_cal": np.asarray(p_cal, dtype=float),
        })
        if with_outcome:
            sub["outcome"] = outcome_fn(df).to_numpy(dtype=int)
        rows.append(sub)
    if not rows:
        return pd.DataFrame()
    return pd.concat(rows, ignore_index=True)


def select_picks(long_df, prag, conf_high, top):
    """Regula de selecție: max 1 pont/fixtură (piața cu p_cal maxim) → filtru
    p_cal>=prag ȘI confidence>=conf_high → top N per zi, rankate p_cal desc."""
    if long_df.empty:
        return long_df
    # 1) diversificare: per fixtură păstrăm piața cu p_cal maxim.
    idx = long_df.groupby("fixture_id")["p_cal"].idxmax()
    best = long_df.loc[idx].copy()
    # 2) filtru prag + confidence HIGH.
    best = best[(best["p_cal"] >= prag) & (best["confidence"] >= conf_high)]
    if best.empty:
        return best
    # 3) top N per zi (rankate p_cal desc).
    best = best.sort_values(["day", "p_cal"], ascending=[True, False])
    return best.groupby("day", group_keys=False).head(top)


def run_today(prag, conf_high, top):
    models, calib = _load_models_and_calib()
    conn = ta.get_conn()
    df = pd.read_sql(QUERY_TODAY, conn)
    conn.close()
    print(f"\n=== PONTURILE ZILEI ===  prag={prag:.2f} | confidence≥{conf_high:g} | top {top}")
    print(f"Fixturi cu predicție AZI: {len(df)}")
    if df.empty:
        print("Niciun meci cu predicție azi.")
        return
    df = _prep_features(df)
    long_df = _build_long(df, models, calib, with_outcome=False)
    picks = select_picks(long_df, prag, conf_high, top)
    if picks.empty:
        print("Niciun pont peste prag + confidence HIGH azi.")
        return
    print(f"\n{'#':>2}  {'P_CAL':>6}  {'CONF':>5}  {'PIAȚĂ':<18} MECI / LIGĂ")
    for i, (_, r) in enumerate(picks.iterrows(), 1):
        print(f"{i:>2}  {r['p_cal']*100:5.1f}%  {r['confidence']:5.1f}  {r['market']:<18} "
              f"{r['home_team']} - {r['away_team']}  [{r['league_name']}]")


def run_backtest(days, conf_high, top):
    models, calib = _load_models_and_calib()
    conn = ta.get_conn()
    df = pd.read_sql(QUERY_BACKTEST, conn, params={"days": str(days)})
    conn.close()
    print(f"\n=== BACKTEST {days} zile ===  confidence≥{conf_high:g} | top {top}/zi")
    print(f"Meciuri jucate cu predicție: {len(df)}")
    if len(df) < 50:
        print("⚠ Prea puține meciuri pentru backtest relevant.")
        return
    df = _prep_features(df)
    long_df = _build_long(df, models, calib, with_outcome=True)
    if long_df.empty:
        print("Nicio piață de încredere disponibilă în model.")
        return

    n_zile_total = long_df["day"].nunique()
    print(f"Zile distincte în fereastră: {n_zile_total}\n")
    print(f"{'PRAG':>5}  {'ponturi':>7}  {'zile_active':>11}  {'medie/zi':>8}  "
          f"{'hit-rate':>8}  {'zile_all_win':>12}")
    for prag in [0.85, 0.88, 0.90, 0.92]:
        picks = select_picks(long_df, prag, conf_high, top)
        total = len(picks)
        if total == 0:
            print(f"{prag:>5.2f}  {0:>7}  {0:>11}  {'—':>8}  {'—':>8}  {'—':>12}")
            continue
        won = int(picks["outcome"].sum())
        hit = won / total
        zile_active = picks["day"].nunique()
        medie = total / zile_active
        # % zile în care TOATE ponturile selectate au câștigat (pt compound).
        per_day = picks.groupby("day")["outcome"].agg(["sum", "count"])
        zile_all_win = int((per_day["sum"] == per_day["count"]).sum())
        pct_all_win = zile_all_win / zile_active * 100
        print(f"{prag:>5.2f}  {total:>7}  {zile_active:>11}  {medie:>8.2f}  "
              f"{hit*100:>7.1f}%  {zile_all_win:>4}/{zile_active} ({pct_all_win:>4.0f}%)")
    print("\nLegendă: hit-rate = câștigate/total ponturi. zile_all_win = zile în care")
    print("TOATE ponturile selectate au câștigat (relevant pt bilet compound zilnic).")


def main():
    ap = argparse.ArgumentParser(description="AlohaScan — selecție ponturi zilnice (prototip read-only).")
    ap.add_argument("--backtest", action="store_true", help="rulează backtest pe ultimele --days zile")
    ap.add_argument("--prag", type=float, default=0.88, help="prag p_calibrat în mod AZI (default 0.88)")
    ap.add_argument("--conf-high", type=float, default=80.0, help="prag confidence HIGH (default 80)")
    ap.add_argument("--days", type=int, default=90, help="fereastră backtest în zile (default 90)")
    ap.add_argument("--top", type=int, default=5, help="număr maxim de ponturi/zi (default 5)")
    args = ap.parse_args()

    if args.backtest:
        run_backtest(args.days, args.conf_high, args.top)
    else:
        run_today(args.prag, args.conf_high, args.top)


if __name__ == "__main__":
    main()
