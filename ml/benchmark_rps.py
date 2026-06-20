#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
benchmark_rps.py — BENCHMARK READ-ONLY al creierului PRE-MECI pe 1X2 vs PIAȚA de pariuri.

Metrică principală: RPS (Ranked Probability Score) — cumulativ, pe ordinea [gazdă, egal, oaspete].
Compară:
  (a) MODELUL meu  = predictions.home_win_prob / draw_prob / away_win_prob  (Poisson,
      scrise PRE-MECI de api/cron/collect-daily.js => OUT-OF-SAMPLE, fără hindsight)
  (b) PIAȚA        = cote 1X2 Bet365 (odds, bookmaker_id=8, bet_name='Match Winner'),
      transformate în probabilități: implied_i = 1/cota_i, normalizate proporțional
      (÷ Σimplied) ca să scoatem marja casei.
Rezultat real = fixtures_history (home_goals/away_goals).

ZERO scrieri în DB, ZERO producție atinsă. Doar SELECT-uri.

Conectare DB: _load_env('/root/scannerv2/.env') + psycopg2 (patternul din ml/experiment_elo.py).

Rulare (single-line):
  python3 ml/benchmark_rps.py                      # sezoane 2025,2026 (+2026 separat)
  python3 ml/benchmark_rps.py --seasons 2026
  python3 ml/benchmark_rps.py --by-league --min-league-n 30

Notă metodă: normalizare PROPORȚIONALĂ (default). Metoda Shin (estimează insider trading
și e puțin mai precisă la marje mari) NU e folosită aici — se poate adăuga ulterior; o
menționez explicit ca să fie clar ce raportez.
"""

import os
import sys
import math
import argparse

import numpy as np

ENV_PATH = "/root/scannerv2/.env"
BOOKMAKER_ID = 8          # Bet365 (singurul colectat de collect-finished)
MAIN_SEASONS = [2025, 2026]
# Reper interpretare RPS 1X2: ~0.19 elită, ~0.20-0.21 nivel casă/foarte bun, >0.23 slab.
ELITE, HOUSE = 0.19, 0.21


# ── DB (read-only) ────────────────────────────────────────────────────────────
def _load_env(path=ENV_PATH):
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k = k.strip(); v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except FileNotFoundError:
        pass


def get_conn():
    import psycopg2
    _load_env()
    url = os.getenv("POSTGRES_URL")
    if url:
        return psycopg2.connect(url)
    return psycopg2.connect(
        dbname=os.getenv("PGDATABASE", "elefant"), user=os.getenv("PGUSER", "alohascan"),
        password=os.getenv("PGPASSWORD"), host=os.getenv("PGHOST", "127.0.0.1"),
        port=os.getenv("PGPORT", "5432"))


def fetch_rows(cur, seasons, bookmaker_id):
    """
    Un rând per fixtur cu: probele mele 1X2, cotele Bet365 1X2, scorul final, sezon, ligă.
    Pivotare cote din EAV cu MAX(...) FILTER. HAVING garantează toate 3 cotele prezente.
    """
    cur.execute(
        """
        SELECT fh.fixture_id, fh.season,
               p.league_id, COALESCE(lg.name, p.league_name, 'lg'||p.league_id::text) AS league,
               fh.home_goals, fh.away_goals,
               p.home_win_prob, p.draw_prob, p.away_win_prob,
               MAX(o.value_odd) FILTER (WHERE o.value_name='Home') AS odd_home,
               MAX(o.value_odd) FILTER (WHERE o.value_name='Draw') AS odd_draw,
               MAX(o.value_odd) FILTER (WHERE o.value_name='Away') AS odd_away
          FROM fixtures_history fh
          JOIN predictions p ON p.fixture_id = fh.fixture_id
          JOIN odds o ON o.fixture_id = fh.fixture_id
                     AND o.bookmaker_id = %s
                     AND o.bet_name = 'Match Winner'
                     AND o.value_name IN ('Home','Draw','Away')
          LEFT JOIN leagues lg ON lg.league_id = p.league_id
         WHERE fh.home_goals IS NOT NULL AND fh.away_goals IS NOT NULL
           AND p.home_win_prob IS NOT NULL AND p.draw_prob IS NOT NULL AND p.away_win_prob IS NOT NULL
           AND fh.season = ANY(%s)
         GROUP BY fh.fixture_id, fh.season, p.league_id, league,
                  fh.home_goals, fh.away_goals,
                  p.home_win_prob, p.draw_prob, p.away_win_prob
        HAVING COUNT(DISTINCT o.value_name) = 3
           AND MAX(o.value_odd) FILTER (WHERE o.value_name='Home') > 1.0
           AND MAX(o.value_odd) FILTER (WHERE o.value_name='Draw') > 1.0
           AND MAX(o.value_odd) FILTER (WHERE o.value_name='Away') > 1.0
        """, (bookmaker_id, list(seasons)))
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


# ── Probabilități + metrici ────────────────────────────────────────────────────
def normalize(mat):
    """Normalizează fiecare rând să sumeze 1 (proporțional)."""
    s = mat.sum(axis=1, keepdims=True)
    s[s == 0] = 1.0
    return mat / s


def build_arrays(rows):
    """Întoarce P_model, P_market (normalizate), outcome (0=H,1=D,2=A), season, league."""
    pm, mk, out, ssn, lg = [], [], [], [], []
    for r in rows:
        # model: procente -> [H,D,A], normalizat (corectează rotunjirile)
        pm.append([float(r["home_win_prob"]), float(r["draw_prob"]), float(r["away_win_prob"])])
        # piață: implied = 1/cota, normalizat proporțional (scoate marja)
        oh, od, oa = float(r["odd_home"]), float(r["odd_draw"]), float(r["odd_away"])
        mk.append([1.0 / oh, 1.0 / od, 1.0 / oa])
        hg, ag = int(r["home_goals"]), int(r["away_goals"])
        out.append(0 if hg > ag else (1 if hg == ag else 2))
        ssn.append(int(r["season"]))
        lg.append(r["league"])
    P = normalize(np.array(pm, dtype=np.float64))
    M = normalize(np.array(mk, dtype=np.float64))
    O = np.zeros_like(P)
    O[np.arange(len(out)), np.array(out)] = 1.0
    return P, M, O, np.array(ssn), np.array(lg, dtype=object), np.array(out)


def rps(probs, onehot):
    """RPS cumulativ pe [H,D,A] (3 categorii): mean_k (CDF_pred - CDF_obs)^2 / (r-1)."""
    cP = np.cumsum(probs, axis=1)
    cO = np.cumsum(onehot, axis=1)
    # k = 1..r-1 (primele 2 praguri cumulative; al 3-lea e 1=1 => 0)
    return ((cP[:, :2] - cO[:, :2]) ** 2).sum(axis=1) / (probs.shape[1] - 1)


def logloss(probs, onehot):
    p_actual = (probs * onehot).sum(axis=1)
    return float(-np.mean(np.log(np.clip(p_actual, 1e-15, 1.0))))


def accuracy(probs, onehot):
    return float(np.mean(np.argmax(probs, axis=1) == np.argmax(onehot, axis=1)))


def overround(rows):
    s = [1.0 / float(r["odd_home"]) + 1.0 / float(r["odd_draw"]) + 1.0 / float(r["odd_away"])
         for r in rows]
    return float(np.mean(s)) if s else float("nan")


# ── Raport ─────────────────────────────────────────────────────────────────────
def _interp(v):
    if v <= ELITE:
        return "elită"
    if v <= HOUSE:
        return "nivel casă / foarte bun"
    return "sub nivelul casei"


def report_block(title, P, M, O, rows_for_overround=None):
    rps_m = float(rps(P, O).mean())
    rps_k = float(rps(M, O).mean())
    lines = []
    lines.append("─" * 70)
    lines.append(" %s   (N=%d meciuri)" % (title, len(P)))
    lines.append("─" * 70)
    lines.append(" %-22s %12s %12s %10s" % ("", "RPS↓", "LogLoss↓", "Acc↑"))
    lines.append(" %-22s %12.5f %12.5f %9.1f%%" % (
        "MODELUL meu", rps_m, logloss(P, O), 100 * accuracy(P, O)))
    lines.append(" %-22s %12.5f %12.5f %9.1f%%" % (
        "PIAȚA (Bet365)", rps_k, logloss(M, O), 100 * accuracy(M, O)))
    d = rps_m - rps_k
    verdict = "MODELUL bate piața" if d < 0 else ("egal" if abs(d) < 1e-4 else "piața e mai bună")
    lines.append("")
    lines.append(" Δ RPS (model − piață) = %+.5f  →  %s" % (d, verdict))
    lines.append(" Interpretare: model %s (%.5f) · piață %s (%.5f) · [reper ~%.2f elită, ~%.2f casă]"
                 % (_interp(rps_m), rps_m, _interp(rps_k), rps_k, ELITE, HOUSE))
    if rows_for_overround:
        lines.append(" Overround mediu Bet365 = %.3f (marjă ~%.1f%%)" % (
            overround(rows_for_overround), 100 * (overround(rows_for_overround) - 1)))
    return "\n".join(lines), rps_m, rps_k


def report_by_league(P, M, O, lg, min_n):
    rps_m = rps(P, O); rps_k = rps(M, O)
    rows = []
    for name in sorted(set(lg.tolist())):
        m = (lg == name)
        n = int(m.sum())
        if n < min_n:
            continue
        rows.append((name, n, float(rps_m[m].mean()), float(rps_k[m].mean())))
    rows.sort(key=lambda r: r[2] - r[3])   # cele unde modelul bate piața cel mai mult întâi
    out = ["", "─" * 70, " DEFALCARE PE LIGĂ (n≥%d)   [Δ<0 = modelul bate piața]" % min_n,
           "─" * 70, " %-30s %6s %10s %10s %9s" % ("ligă", "n", "RPS_mod", "RPS_piață", "Δ")]
    for name, n, rm, rk in rows:
        out.append(" %-30s %6d %10.5f %10.5f %+9.5f" % (str(name)[:30], n, rm, rk, rm - rk))
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description="Benchmark RPS 1X2 pre-meci: model vs piață (read-only).")
    ap.add_argument("--seasons", type=str, default=",".join(str(s) for s in MAIN_SEASONS),
                    help="sezoane pt RPS principal (default 2025,2026)")
    ap.add_argument("--bookmaker", type=int, default=BOOKMAKER_ID, help="bookmaker_id (default 8=Bet365)")
    ap.add_argument("--by-league", action="store_true", help="defalcare pe ligă")
    ap.add_argument("--min-league-n", type=int, default=25, help="prag minim meciuri/ligă pt defalcare")
    args = ap.parse_args()

    seasons = [int(s) for s in args.seasons.split(",") if s.strip()]
    conn = get_conn()
    cur = conn.cursor()
    rows = fetch_rows(cur, seasons, args.bookmaker)
    cur.close(); conn.close()

    if not rows:
        print("0 meciuri cu toate trei (predicție + cote 1X2 + rezultat). Verifică sezoanele/odds.")
        sys.exit(2)

    P, M, O, ssn, lg, _ = build_arrays(rows)
    print("=" * 70)
    print(" BENCHMARK RPS 1X2 PRE-MECI — MODEL (Poisson, out-of-sample) vs PIAȚĂ (Bet365)")
    print("=" * 70)
    print(" Sezoane: %s | bookmaker_id=%d | normalizare cote = proporțională (1/cota ÷ Σ)" % (
        seasons, args.bookmaker))

    block, _, _ = report_block("PRINCIPAL — sezoane %s" % seasons, P, M, O, rows_for_overround=rows)
    print(block)

    # 2026 separat (dacă e în set)
    if 2026 in set(ssn.tolist()):
        m = (ssn == 2026)
        b26, _, _ = report_block("DOAR 2026", P[m], M[m], O[m])
        print(b26)

    if args.by_league:
        print(report_by_league(P, M, O, lg, args.min_league_n))

    print("=" * 70)
    print(" READ-ONLY: zero scrieri în DB, zero producție atinsă.")


if __name__ == "__main__":
    main()
