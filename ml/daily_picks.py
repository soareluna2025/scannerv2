"""
AlohaScan — daily_picks.py — MOTOR PONTURI pe PATTERN ISTORIC (read-only, zero model).

CONCEPT: pentru fiecare meci viitor ne uităm la rata REALĂ istorică a pieței în
„zona" lui = (ligă × bandă de goluri-așteptate, din lambda Poisson). Scoatem pontul
DOAR dacă zona e dovedit fiabilă (N mare + rată mare). Zero model ML, zero cote —
doar istoric real.

Banding-ul folosește predictions.lambda_* (NU ml_features.xg) — fixturile VIITOARE
n-au rânduri în ml_features, dar AU lambda în predictions.

READ-ONLY pe DB (doar SELECT). NU atinge enrich/ml-predict/scoring/calibrare/
frontend/cron. Conexiunea (.env + psycopg2) e REFOLOSITĂ din ml/test_accuracy.py.

Interfața PĂSTRATĂ: `--write` scrie public/daily_picks.json în ACELAȘI format
(generated_at + picks[{home,away,league_name,market,p_cal,p_poisson,confidence}]) →
tickerul și pagina existente merg neschimbate.

Rulare:
  python3 ml/daily_picks.py --write [--market all|gazde|oaspeti|over15] [--min-n 200] [--min-rate 0.80] [--hours 24]
  python3 ml/daily_picks.py                 # DIAGNOSTIC (tabel ponturi azi, nu scrie)
  python3 ml/daily_picks.py --backtest      # stabilitate zone (split temporal 80/20)
"""

import os
import json
import argparse
from datetime import datetime, timezone
import numpy as np
import pandas as pd

# REFOLOSIRE conexiune DB (.env, psycopg2) — exact ca în test_accuracy.py.
import test_accuracy as ta

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
DAILY_PICKS_JSON = os.path.join(os.path.dirname(_THIS_DIR), "public", "daily_picks.json")

# Benzi de goluri-așteptate (lambda). Half-open [lo, hi); ultima prinde restul.
TEAM_BANDS = [
    (-np.inf, 0.8, "<0.8"), (0.8, 1.0, "0.8-1.0"), (1.0, 1.2, "1.0-1.2"),
    (1.2, 1.5, "1.2-1.5"), (1.5, 1.8, "1.5-1.8"), (1.8, np.inf, ">=1.8"),
]
TOTAL_BANDS = [
    (-np.inf, 2.0, "<2.0"), (2.0, 2.5, "2.0-2.5"), (2.5, 3.0, "2.5-3.0"),
    (3.0, 3.5, "3.0-3.5"), (3.5, 4.0, "3.5-4.0"), (4.0, np.inf, ">=4.0"),
]

# piață → (coloana lambda pt bandă, benzi). over15 = bandă din lambda_home+lambda_away
# (lambda_total e ~90% NULL în predicțiile istorice → nu folosim coloana).
MARKETS = {
    "gazde":   {"col": "lambda_home",  "bands": TEAM_BANDS},
    "oaspeti": {"col": "lambda_away",  "bands": TEAM_BANDS},
    "over15":  {"col": None,           "bands": TOTAL_BANDS},
}
MARKET_LABEL = {"gazde": "Gazde marchează", "oaspeti": "Oaspeții marchează", "over15": "Over 1.5"}
ALL_MARKETS = ["gazde", "oaspeti", "over15"]


# Istoric: meciuri FT cu scor (fixtures_history) + lambda (predictions). Banding din
# predictions.lambda_*; outcome din fixtures_history. Ordonat temporal pt split backtest.
QUERY_HISTORY = """
SELECT p.fixture_id, p.league_id, p.match_date,
       fh.home_goals, fh.away_goals,
       p.lambda_home, p.lambda_away
FROM predictions p
JOIN fixtures_history fh ON fh.fixture_id = p.fixture_id
WHERE fh.status_short = 'FT'
  AND fh.home_goals IS NOT NULL AND fh.away_goals IS NOT NULL
ORDER BY p.match_date ASC
"""

# Viitor: meciuri NEÎNCEPUTE în următoarele N ore (fereastră absolută, fără fus).
# Banding din predictions.lambda_* — FĂRĂ ml_features (viitorul n-are xg).
QUERY_FUTURE = """
SELECT p.fixture_id, p.home_team, p.away_team, p.league_name, p.league_id,
       p.lambda_home, p.lambda_away
FROM predictions p
WHERE p.match_date >= NOW()
  AND p.match_date <  NOW() + (%(hours)s || ' hours')::interval
ORDER BY p.match_date ASC
"""


def band_of(x, bands):
    for lo, hi, lab in bands:
        if x >= lo and x < hi:
            return lab
    return bands[-1][2]


def _market_lam_series(df, market):
    """Seria lambda relevantă pt bandă, per piață. over15 = lambda_home+lambda_away
    (lambda_total e ~90% NULL); gazde/oaspeti = coloana proprie."""
    if market == "over15":
        return (pd.to_numeric(df["lambda_home"], errors="coerce")
                + pd.to_numeric(df["lambda_away"], errors="coerce"))
    return pd.to_numeric(df[MARKETS[market]["col"]], errors="coerce")


def _market_hit_series(df, market):
    hg = pd.to_numeric(df["home_goals"], errors="coerce")
    ag = pd.to_numeric(df["away_goals"], errors="coerce")
    if market == "gazde":
        return (hg >= 1).astype(int)
    if market == "oaspeti":
        return (ag >= 1).astype(int)
    return ((hg + ag) >= 2).astype(int)


def _future_lam(row, market):
    if market == "over15":
        h = row.get("lambda_home"); a = row.get("lambda_away")
        h = float(h) if (h is not None and not pd.isna(h)) else None
        a = float(a) if (a is not None and not pd.isna(a)) else None
        if h is None or a is None:
            return None
        return h + a
    v = row.get(MARKETS[market]["col"])
    return float(v) if (v is not None and not pd.isna(v)) else None


def load_history(conn):
    df = pd.read_sql(QUERY_HISTORY, conn)
    for c in ["home_goals", "away_goals", "lambda_home", "lambda_away"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def load_future(conn, hours):
    return pd.read_sql(QUERY_FUTURE, conn, params={"hours": str(hours)})


# ── PASUL 1 — TABEL DE FIABILITATE (din istoric) ─────────────────────────────
def build_reliability(hist, market, min_n, min_rate):
    """Zone (league_id × bandă) cu R=hits/N. Întoarce dict {(lid,band):(R,N)} cu
    DOAR zonele păstrate (N>=min_n ȘI R>=min_rate)."""
    bands = MARKETS[market]["bands"]
    lam = _market_lam_series(hist, market)
    mask = lam.notna()
    sub = hist[mask].copy()
    if sub.empty:
        return {}
    sub["_band"] = lam[mask].map(lambda v: band_of(v, bands))
    sub["_hit"] = _market_hit_series(sub, market).to_numpy()
    g = sub.groupby(["league_id", "_band"])["_hit"]
    R = g.mean(); N = g.size()
    kept = {}
    for key in R.index:
        n = int(N[key]); r = float(R[key])
        if n >= min_n and r >= min_rate:
            kept[key] = (r, n)
    return kept


# ── PAS 2+3 — meciuri viitoare → selecție pe zone fiabile ────────────────────
def select_today(hist, future, markets, min_n, min_rate):
    rel = {m: build_reliability(hist, m, min_n, min_rate) for m in markets}
    best_per_fixture = {}
    for _, row in future.iterrows():
        lid = row["league_id"]
        best = None
        for m in markets:
            lamv = _future_lam(row, m)
            if lamv is None:
                continue
            band = band_of(lamv, MARKETS[m]["bands"])
            zone = rel[m].get((lid, band))
            if zone is None:
                continue
            R, N = zone
            if best is None or R > best["R"]:
                best = {"fixture_id": row["fixture_id"], "home": row["home_team"],
                        "away": row["away_team"], "league_name": row["league_name"],
                        "league_id": lid, "market": m, "R": R, "N": N, "band": band}
        if best is not None:
            best_per_fixture[row["fixture_id"]] = best   # O singură piață/meci (R maxim)
    picks = sorted(best_per_fixture.values(), key=lambda d: d["R"], reverse=True)
    # Max 2 ponturi/ligă, FĂRĂ plafon total.
    out, lg = [], {}
    for p in picks:
        if lg.get(p["league_id"], 0) >= 2:
            continue
        out.append(p); lg[p["league_id"]] = lg.get(p["league_id"], 0) + 1
    return out


# ── PASUL 4 — output ─────────────────────────────────────────────────────────
def write_json(picks, out_path=DAILY_PICKS_JSON):
    picks_list = [{
        "home": p["home"], "away": p["away"], "league_name": p["league_name"],
        "market": MARKET_LABEL[p["market"]],
        "p_cal": round(p["R"], 4), "p_poisson": round(p["R"], 4),
        "confidence": round(p["R"] * 100),
    } for p in picks]
    payload = {"generated_at": datetime.now(timezone.utc).isoformat(), "picks": picks_list}
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    print(f"Scris {len(picks_list)} ponturi în {out_path} (generated_at={payload['generated_at']}).")


def print_diagnostic(picks):
    print(f"=== PONTURILE ZILEI (pattern istoric) — {len(picks)} ponturi ===")
    if not picks:
        print("Niciun pont — nicio zonă fiabilă pe meciurile viitoare.")
        return
    print(f"{'R%':>5} {'N_zonă':>7}  {'PIAȚĂ':<18} {'BANDĂ':>8}  MECI [LIGĂ]")
    for p in picks:
        print(f"{p['R']*100:>5.1f} {p['N']:>7}  {MARKET_LABEL[p['market']]:<18} "
              f"{p['band']:>8}  {p['home']} - {p['away']} [{p['league_name']}]")


# ── MOD --backtest — stabilitate zone (split temporal 80/20) ─────────────────
def run_backtest(hist, markets, min_n, min_rate, train_frac=0.8):
    for m in markets:
        bands = MARKETS[m]["bands"]
        lam = _market_lam_series(hist, m)
        mask = lam.notna()
        sub = hist[mask].copy()
        sub["_band"] = lam[mask].map(lambda v: band_of(v, bands))
        sub["_hit"] = _market_hit_series(sub, m).to_numpy()
        sub = sub.sort_values("match_date")
        n = len(sub)
        print("\n" + "=" * 78)
        print(f" {MARKET_LABEL[m]} — backtest stabilitate (train {train_frac:.0%} / test) | N={n}")
        print("=" * 78)
        if n < 200:
            print(" Prea puține meciuri — skip.")
            continue
        cut = int(n * train_frac)
        train, test = sub.iloc[:cut], sub.iloc[cut:]
        gtr = train.groupby(["league_id", "_band"])["_hit"]; Rtr = gtr.mean(); Ntr = gtr.size()
        gte = test.groupby(["league_id", "_band"])["_hit"]; Rte = gte.mean(); Nte = gte.size()
        rows = []
        for key in Rtr.index:
            ntr = int(Ntr[key]); rtr = float(Rtr[key])
            if ntr < min_n or rtr < min_rate:
                continue
            if key in Rte.index:
                rte = float(Rte[key]); nte = int(Nte[key]); d = (rte - rtr) * 100
                flag = "STABIL" if abs(d) <= 5.0 else "INSTABIL"
            else:
                rte = None; nte = 0; d = None; flag = "fără test"
            rows.append((key[0], key[1], ntr, rtr, nte, rte, d, flag))
        rows.sort(key=lambda r: r[3], reverse=True)
        if not rows:
            print(" Nicio zonă păstrată (N_train/min-rate).")
            continue
        print(f"{'liga':>8} {'bandă':>8} {'N_tr':>6} {'r_tr%':>6} {'N_te':>6} {'r_te%':>6} {'Δpp':>6}  flag")
        print("-" * 78)
        for lid, band, ntr, rtr, nte, rte, d, flag in rows:
            rte_s = f"{rte*100:6.1f}" if rte is not None else f"{'—':>6}"
            d_s = f"{d:+6.1f}" if d is not None else f"{'—':>6}"
            mark = "✅" if flag == "STABIL" else ("⚠️" if flag == "INSTABIL" else "·")
            print(f"{lid:>8} {band:>8} {ntr:>6} {rtr*100:>6.1f} {nte:>6} {rte_s} {d_s}  {mark} {flag}")
        n_stab = sum(1 for r in rows if r[7] == "STABIL")
        n_inst = sum(1 for r in rows if r[7] == "INSTABIL")
        print(f" → zone păstrate: {len(rows)} | STABILE: {n_stab} | INSTABILE: {n_inst} | fără test: {len(rows)-n_stab-n_inst}")
    print("\nNotă: STABIL = |rata_test - rata_train| <= 5pp. INSTABIL = overfit/zgomot/leakage.")


def main():
    ap = argparse.ArgumentParser(description="AlohaScan — ponturi pe pattern istoric (read-only).")
    ap.add_argument("--write", action="store_true", help="scrie public/daily_picks.json (ponturile AZI)")
    ap.add_argument("--backtest", action="store_true", help="stabilitate zone (split temporal 80/20)")
    ap.add_argument("--market", choices=["gazde", "oaspeti", "over15", "all"], default="all")
    ap.add_argument("--min-n", type=int, default=200, help="N minim pe zonă (default 200)")
    ap.add_argument("--min-rate", type=float, default=0.75, help="rată minimă pe zonă (default 0.75)")
    ap.add_argument("--hours", type=int, default=24, help="fereastră meciuri viitoare în ore (default 24)")
    args = ap.parse_args()

    markets = ALL_MARKETS if args.market == "all" else [args.market]

    conn = ta.get_conn()
    if args.backtest:
        hist = load_history(conn)
        conn.close()
        run_backtest(hist, markets, args.min_n, args.min_rate)
        return

    hist = load_history(conn)
    future = load_future(conn, args.hours)
    conn.close()
    picks = select_today(hist, future, markets, args.min_n, args.min_rate)
    if args.write:
        write_json(picks)
    else:
        print_diagnostic(picks)


if __name__ == "__main__":
    main()
