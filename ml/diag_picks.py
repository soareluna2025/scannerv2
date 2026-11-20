"""
AlohaScan — diag_picks.py — DIAGNOSTIC READ-ONLY pentru "Ponturile Zilei" goale.

Răspunde la: de ce daily_picks.py scrie 0 ponturi cu meciuri viitoare existente?
Pentru fiecare meci din următoarele N ore arată zona lui istorică (ligă × bandă lambda):
N (mărime eșantion) și R (rată reală), apoi care prag (N>=min_n sau R>=min_rate) o blochează.
NU scrie nimic (nici DB, nici public/daily_picks.json). Doar SELECT.

Rulare (din /root/scannerv2, cu .env încărcat):
  python3 ml/diag_picks.py [--hours 24] [--min-n 200] [--min-rate 0.70]
"""
import argparse
import warnings

warnings.filterwarnings("ignore", message="pandas only supports SQLAlchemy")


def zone_table(dp, hist, market):
    """DataFrame (league_id, band) -> N, R, FĂRĂ praguri."""
    bands = dp.MARKETS[market]["bands"]
    lam = dp._market_lam_series(hist, market)
    mask = lam.notna()
    sub = hist[mask].copy()
    if sub.empty:
        return {}
    sub["_band"] = lam[mask].map(lambda v: dp.band_of(v, bands))
    sub["_hit"] = dp._market_hit_series(sub, market).to_numpy()
    g = sub.groupby(["league_id", "_band"])["_hit"]
    return {k: (float(g.mean()[k]), int(g.size()[k])) for k in g.mean().index}


def analyze(dp, hist, future, min_n, min_rate):
    print(f"Istoric (predicții cu rezultat FT): {len(hist)} rânduri")
    print(f"Meciuri viitoare în fereastră: {len(future)}")
    if future.empty:
        print("→ Nu există meciuri viitoare. Problema e în generarea predicțiilor.")
        return
    for col in ("lambda_home", "lambda_away"):
        nn = int(future[col].notna().sum())
        print(f"  {col} completat: {nn}/{len(future)}")

    zones = {m: zone_table(dp, hist, m) for m in dp.ALL_MARKETS}
    for m in dp.ALL_MARKETS:
        z = zones[m]
        ok = sum(1 for (r, n) in z.values() if n >= min_n and r >= min_rate)
        big = sum(1 for (r, n) in z.values() if n >= min_n)
        hi = sum(1 for (r, n) in z.values() if r >= min_rate)
        print(f"Piața {m:8s}: {len(z)} zone | N>={min_n}: {big} | R>={min_rate:.2f}: {hi} | AMBELE (păstrate): {ok}")

    rows = []
    for _, row in future.iterrows():
        best = None
        for m in dp.ALL_MARKETS:
            lamv = dp._future_lam(row, m)
            if lamv is None:
                continue
            band = dp.band_of(lamv, dp.MARKETS[m]["bands"])
            z = zones[m].get((row["league_id"], band))
            if z is None:
                continue
            r, n = z
            if best is None or r > best[2]:
                best = (m, band, r, n)
        rows.append((row["home_team"], row["away_team"], row.get("league_name"), best))

    no_zone = sum(1 for x in rows if x[3] is None)
    small = sum(1 for x in rows if x[3] and x[3][3] < min_n)
    low = sum(1 for x in rows if x[3] and x[3][3] >= min_n and x[3][2] < min_rate)
    ok = sum(1 for x in rows if x[3] and x[3][3] >= min_n and x[3][2] >= min_rate)
    print(f"\nDin {len(rows)} meciuri: fără zonă în istoric={no_zone} | zonă cu N<{min_n}={small} "
          f"| N ok dar R<{min_rate:.2f}={low} | PASĂ={ok}")

    ranked = sorted([x for x in rows if x[3]], key=lambda x: x[3][2], reverse=True)[:15]
    print("\nTOP 15 meciuri după rata zonei (piață, bandă, R, N):")
    for h, a, lg, (m, band, r, n) in ranked:
        flag = "OK " if (n >= min_n and r >= min_rate) else ("N<  " if n < min_n else "R<  ")
        print(f" {flag}{r*100:5.1f}%  N={n:5d}  {m:8s} {band:8s} {h} vs {a} [{lg}]")


def main():
    ap = argparse.ArgumentParser(description="Diagnostic ponturi goale (read-only).")
    ap.add_argument("--hours", type=int, default=24)
    ap.add_argument("--min-n", type=int, default=200)
    ap.add_argument("--min-rate", type=float, default=0.70)
    args = ap.parse_args()

    import daily_picks as dp
    conn = dp.ta.get_conn()
    hist = dp.load_history(conn)
    future = dp.load_future(conn, args.hours)
    conn.close()
    analyze(dp, hist, future, args.min_n, args.min_rate)


if __name__ == "__main__":
    main()
