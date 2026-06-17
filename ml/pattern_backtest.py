"""
AlohaScan — pattern_backtest.py — DESCOPERIRE zone de specializare (read-only).

Caută combinații (ligă × bandă goluri-așteptate) unde rata reală a unei piețe Over
e mare ȘI STABILĂ out-of-sample. Anti-leakage prin split TEMPORAL strict (train =
trecut, test = viitor, disjuncte). Diagnostic — NU atinge model/scoring/enrich/
ml-predict/daily_picks. Read-only pe DB.

Conexiunea (.env + psycopg2) e REFOLOSITĂ din ml/test_accuracy.py (get_conn).

Rulare:
  python3 ml/pattern_backtest.py [--market over25|over15|btts] [--train-frac 0.8]
                                 [--min-n-train 200] [--min-n-test 50]
"""

import argparse
import numpy as np
import pandas as pd

# REFOLOSIRE conexiune DB (.env, psycopg2) — exact ca în test_accuracy.py / daily_picks.py.
import test_accuracy as ta


# Date brute: meciuri FT cu scor final + xg mediu (ml_features). LEFT JOIN leagues
# pt nume (leagues.league_id PK + name NOT NULL — sigur). Order temporal pt split.
QUERY = """
SELECT
    fh.fixture_id, fh.league_id, l.name AS league_name, fh.match_date,
    fh.home_goals, fh.away_goals,
    mlf.home_xg_avg, mlf.away_xg_avg
FROM fixtures_history fh
JOIN ml_features mlf ON mlf.fixture_id = fh.fixture_id
LEFT JOIN leagues l ON l.league_id = fh.league_id
WHERE fh.status_short = 'FT'
  AND fh.home_goals IS NOT NULL AND fh.away_goals IS NOT NULL
  AND mlf.home_xg_avg IS NOT NULL AND mlf.away_xg_avg IS NOT NULL
ORDER BY fh.match_date ASC
"""

# Benzi de xg_total (half-open [lo, hi)); >=4.0 prinde restul.
BANDS = [
    (-np.inf, 2.0, "<2.0"),
    (2.0, 2.5, "2.0-2.5"),
    (2.5, 3.0, "2.5-3.0"),
    (3.0, 3.5, "3.0-3.5"),
    (3.5, 4.0, "3.5-4.0"),
    (4.0, np.inf, ">=4.0"),
]


def band_of(x):
    for lo, hi, lab in BANDS:
        if x >= lo and x < hi:
            return lab
    return ">=4.0"


def outcome_series(df, market):
    tg = df["home_goals"] + df["away_goals"]
    if market == "over25":
        return (tg >= 3).astype(int)
    if market == "over15":
        return (tg >= 2).astype(int)
    if market == "btts":
        return ((df["home_goals"] >= 1) & (df["away_goals"] >= 1)).astype(int)
    raise ValueError(market)


def main():
    ap = argparse.ArgumentParser(description="AlohaScan — backtest pattern ligă×bandă (read-only).")
    ap.add_argument("--market", choices=["over25", "over15", "btts"], default="over25")
    ap.add_argument("--train-frac", type=float, default=0.8, help="fracția cronologică de train (default 0.8)")
    ap.add_argument("--min-n-train", type=int, default=200, help="N minim în train pe bucket (default 200)")
    ap.add_argument("--min-n-test", type=int, default=50, help="N minim în test pe bucket (default 50)")
    args = ap.parse_args()

    conn = ta.get_conn()
    df = pd.read_sql(QUERY, conn)
    conn.close()

    if len(df) < 200:
        print(f"⚠ Prea puține meciuri ({len(df)}) — backtest irelevant.")
        return

    # Numeric + bandă + outcome.
    for c in ["home_goals", "away_goals", "home_xg_avg", "away_xg_avg"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["home_goals", "away_goals", "home_xg_avg", "away_xg_avg"]).reset_index(drop=True)
    df["xg_total"] = df["home_xg_avg"] + df["away_xg_avg"]
    df["band"] = df["xg_total"].map(band_of)
    df["y"] = outcome_series(df, args.market).to_numpy()

    # Split TEMPORAL strict (deja sortat după match_date).
    n = len(df)
    cut = int(n * args.train_frac)
    train = df.iloc[:cut].copy()
    test = df.iloc[cut:].copy()
    if len(train) < 100 or len(test) < 50:
        print(f"⚠ Split insuficient (train={len(train)}, test={len(test)}).")
        return

    print("=" * 78)
    print(f" PATTERN BACKTEST — piață: {args.market} | split temporal train={args.train_frac:.0%}")
    print(f" Total FT cu xg: {n} | train={len(train)} ({train['match_date'].min()} → {train['match_date'].max()})")
    print(f"                        test ={len(test)} ({test['match_date'].min()} → {test['match_date'].max()})")
    print(f" Filtre ranking: N_train>={args.min_n_train}, N_test>={args.min_n_test}")
    print("=" * 78)

    # TRAIN: rata reală + N pe bucket (league_id × band).
    gtr = train.groupby(["league_id", "band"])
    tr_rate = gtr["y"].mean()
    tr_n = gtr["y"].size()
    rate_dict = {k: float(v) for k, v in tr_rate.items()}
    global_train_rate = float(train["y"].mean())

    # Nume ligă (primul nevid per league_id).
    name_map = (df.dropna(subset=["league_name"])
                  .groupby("league_id")["league_name"].first().to_dict())

    # TEST: fiecare meci primește ca predicție rata bucket-ului din TRAIN.
    test["pred"] = [rate_dict.get((lid, b), np.nan)
                    for lid, b in zip(test["league_id"], test["band"])]
    tp = test.dropna(subset=["pred"]).copy()   # doar test-uri cu bucket cunoscut din train

    # Brier OOS: pattern (predicția per-bucket) vs baseline (rata globală constantă),
    # pe ACELEAȘI rânduri de test (comparație corectă).
    if len(tp) > 0:
        brier_pattern = float(np.mean((tp["pred"] - tp["y"]) ** 2))
        brier_base = float(np.mean((global_train_rate - tp["y"]) ** 2))
        cal_pred = float(tp["pred"].mean()) * 100
        cal_real = float(tp["y"].mean()) * 100
    else:
        brier_pattern = brier_base = cal_pred = cal_real = float("nan")

    # TEST: rata reală + N pe bucket.
    gte = test.groupby(["league_id", "band"])
    te_rate = gte["y"].mean()
    te_n = gte["y"].size()

    # Merge train/test pe bucket + filtre ranking.
    rows = []
    for key in te_rate.index:
        lid, band = key
        n_tr = int(tr_n.get(key, 0))
        n_te = int(te_n.get(key, 0))
        if n_tr < args.min_n_train or n_te < args.min_n_test:
            continue
        r_tr = float(tr_rate.get(key, np.nan))
        r_te = float(te_rate.get(key, np.nan))
        delta_pp = (r_te - r_tr) * 100
        flag = "STABIL" if abs(delta_pp) <= 5.0 else "INSTABIL"
        rows.append({
            "league_id": lid, "league_name": name_map.get(lid, ""),
            "band": band, "n_train": n_tr, "rate_train": r_tr,
            "n_test": n_te, "rate_test": r_te, "delta_pp": delta_pp, "flag": flag,
        })

    rows.sort(key=lambda d: d["rate_test"], reverse=True)

    # Tabel.
    print(f"\n{'liga':<22} {'bandă':>7} {'N_tr':>6} {'r_tr%':>6} {'N_te':>6} {'r_te%':>6} {'Δpp':>6}  flag")
    print("-" * 78)
    for r in rows:
        lname = (r["league_name"] or str(r["league_id"]))[:20]
        print(f"{lname:<22} {r['band']:>7} {r['n_train']:>6} {r['rate_train']*100:>6.1f} "
              f"{r['n_test']:>6} {r['rate_test']*100:>6.1f} {r['delta_pp']:>+6.1f}  "
              f"{'✅' if r['flag']=='STABIL' else '⚠️'} {r['flag']}")
    if not rows:
        print("(niciun bucket nu trece pragurile N_train/N_test)")

    # Sumar.
    n_stable = sum(1 for r in rows if r["flag"] == "STABIL")
    n_unstable = len(rows) - n_stable
    print("\n" + "=" * 78)
    print(" SUMAR")
    print("-" * 78)
    print(f" Brier OOS pattern (ligă×bandă) : {brier_pattern:.4f}")
    print(f" Brier OOS baseline (rată globală {global_train_rate*100:.1f}%): {brier_base:.4f}")
    if brier_base == brier_base and brier_base > 0:   # not NaN
        impr = (brier_base - brier_pattern) / brier_base * 100
        verdict = "pattern-ul ADAUGĂ valoare" if brier_pattern < brier_base else "pattern-ul NU bate baseline"
        print(f" Îmbunătățire vs baseline        : {impr:+.1f}%  → {verdict}")
    print(f" Calibrare OOS globală (test cu bucket): predicție {cal_pred:.1f}% vs real {cal_real:.1f}% "
          f"(Δ {cal_real - cal_pred:+.1f}pp)")
    print(f" Bucket-uri rankate              : {len(rows)}  | STABILE: {n_stable}  | INSTABILE: {n_unstable}")
    if rows:
        ratio = n_stable / len(rows) * 100
        print(f" Procent STABILE                 : {ratio:.0f}%  "
              f"({'sănătos' if ratio >= 60 else 'atenție — posibil overfit/leakage'})")
    print("=" * 78)
    print("Notă: STABIL = |rata_test - rata_train| <= 5pp. Δ mare = bucket instabil")
    print("(overfit / zgomot / leakage). Caută buckets cu rata_test mare ȘI STABIL.")


if __name__ == "__main__":
    main()
