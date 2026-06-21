#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
deepdive_sweep.py — SWEEP pe multe ligi care AGREGĂ aceleași metrici „vs realitate" ca
ml/deepdive_belarus.py, ca să vedem TIPARE ROBUSTE (nu zgomot de pe-o-ligă). STRICT READ-ONLY.

REFOLOSEȘTE direct funcțiile per-ligă din deepdive_belarus.py (measure_poisson_vs_result,
measure_live_modules) + benchmark_rps (RPS/normalize). NU reinventează queries, NU modifică
scriptul existent. Procesează O LIGĂ PE RÂND (memorie mică, VPS 2GB) și agregă în SQL unde
se poate. NU atinge motoarele/calcPoisson/producția. Fără scrieri DB.

Selecție automată ligi: ≥MIN_PRE predicții pre-meci cu rezultat SAU ≥MIN_LIVE predicții live
rezolvate. --limit N (test rapid), --min-prematch, --min-live, --seasons.

Rulare:
  nice -n 19 python3 ml/deepdive_sweep.py --limit 8        # test rapid
  nice -n 19 python3 ml/deepdive_sweep.py                  # tot
"""

import os
import sys
import argparse
import statistics

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import benchmark_rps as B
import deepdive_belarus as DD   # refolosire funcții per-ligă (read-only)

MIN_PRE_DEFAULT = 300
MIN_LIVE_DEFAULT = 2000
N_MKT_MIN = 30
SEASONS_DEFAULT = DD.SEASONS_DEFAULT
CAL_OK = 0.05            # ECE sub care zicem „calibrat"


def _dpct(brier, base):
    """Δ% îmbunătățire vs base-rate: (base − brier)/base × 100 (pozitiv = skill)."""
    if base is None or base <= 1e-9 or brier is None:
        return None
    return (base - brier) / base * 100.0


# ── selecție ligi calificate ─────────────────────────────────────────────────
def qualified_leagues(cur, min_pre, min_live):
    pre = {}
    for r in DD._qall(cur,
        """SELECT p.league_id, COUNT(*) FROM predictions p
             JOIN fixtures_history fh ON fh.fixture_id=p.fixture_id
            WHERE fh.home_goals IS NOT NULL AND fh.away_goals IS NOT NULL
              AND p.home_win_prob IS NOT NULL AND p.draw_prob IS NOT NULL AND p.away_win_prob IS NOT NULL
            GROUP BY p.league_id"""):
        if r and r[0] != "ERR" and r[0] is not None:
            pre[int(r[0])] = int(r[1])
    live = {}
    for r in DD._qall(cur,
        """SELECT league_id, COUNT(*) FROM prediction_log
            WHERE outcome IN ('WIN','LOSS') AND predicted_value IS NOT NULL AND COALESCE(minute,0)>0
            GROUP BY league_id"""):
        if r and r[0] != "ERR" and r[0] is not None:
            live[int(r[0])] = int(r[1])
    ids = sorted(set(lid for lid in set(pre) | set(live)
                     if pre.get(lid, 0) >= min_pre or live.get(lid, 0) >= min_live))
    # nume/țară
    meta = {}
    if ids:
        for r in DD._qall(cur, "SELECT league_id, name, country FROM leagues WHERE league_id = ANY(%s)", (ids,)):
            if r and r[0] != "ERR":
                meta[int(r[0])] = (r[1], r[2])
    return ids, pre, live, meta


# ── market 1X2 pe ligă (Poisson vs Bet365, subset cu cote) ───────────────────
def market_rps_league(cur, lid, seasons):
    sql = """
      SELECT fh.home_goals, fh.away_goals, p.home_win_prob, p.draw_prob, p.away_win_prob,
             MAX(o.value_odd) FILTER (WHERE o.value_name='Home') AS oh,
             MAX(o.value_odd) FILTER (WHERE o.value_name='Draw') AS od,
             MAX(o.value_odd) FILTER (WHERE o.value_name='Away') AS oa
        FROM fixtures_history fh
        JOIN predictions p ON p.fixture_id=fh.fixture_id
        JOIN odds o ON o.fixture_id=fh.fixture_id AND o.bookmaker_id=%s
                   AND o.bet_name='Match Winner' AND o.value_name IN ('Home','Draw','Away')
       WHERE fh.league_id=%s AND fh.home_goals IS NOT NULL AND fh.away_goals IS NOT NULL
         AND p.home_win_prob IS NOT NULL AND p.draw_prob IS NOT NULL AND p.away_win_prob IS NOT NULL
         AND fh.season = ANY(%s)
       GROUP BY fh.fixture_id, fh.home_goals, fh.away_goals, p.home_win_prob, p.draw_prob, p.away_win_prob
      HAVING COUNT(DISTINCT o.value_name)=3 AND MIN(o.value_odd)>1.0
    """
    rows = DD._qall(cur, sql, (B.BOOKMAKER_ID, lid, list(seasons)))
    if not rows or rows[0][0] == "ERR" or len(rows) < N_MKT_MIN:
        return None
    P, M, outs = [], [], []
    for hg, ag, ph, pd, pa, oh, od, oa in rows:
        P.append([float(ph), float(pd), float(pa)])
        M.append([1/float(oh), 1/float(od), 1/float(oa)])
        outs.append(0 if hg > ag else (1 if hg == ag else 2))
    P = B.normalize(np.array(P, float)); M = B.normalize(np.array(M, float))
    O = np.zeros_like(P); O[np.arange(len(outs)), outs] = 1
    return dict(N=len(P), rps_noi=float(B.rps(P, O).mean()), rps_mkt=float(B.rps(M, O).mean()))


# ── NGP early/late POOLED (SQL-side, eficient) ───────────────────────────────
def ngp_phase_pooled(cur, ids):
    rows = DD._qall(cur,
        """SELECT league_id,
                  CASE WHEN minute<=60 THEN 'early' ELSE 'late' END AS phase,
                  COUNT(*) AS n,
                  AVG(predicted_value)/100.0 AS pred,
                  AVG(CASE WHEN outcome='WIN' THEN 1.0 ELSE 0.0 END) AS rate
             FROM prediction_log
            WHERE module='NGP' AND outcome IN ('WIN','LOSS') AND predicted_value IS NOT NULL
              AND COALESCE(minute,0)>0 AND league_id = ANY(%s)
            GROUP BY league_id, phase""", (ids,))
    perleague = {}
    for r in rows:
        if not r or r[0] == "ERR":
            continue
        lid, phase, n, pred, rate = int(r[0]), r[1], int(r[2]), float(r[3]), float(r[4])
        perleague.setdefault(lid, {})[phase] = (n, pred, rate)
    # pooled (ponderat pe N)
    def pool(phase):
        N = sum(v[phase][0] for v in perleague.values() if phase in v)
        if N == 0:
            return (0, float("nan"), float("nan"))
        pred = sum(v[phase][0]*v[phase][1] for v in perleague.values() if phase in v)/N
        rate = sum(v[phase][0]*v[phase][2] for v in perleague.values() if phase in v)/N
        return (N, pred, rate)
    return pool("early"), pool("late"), perleague


# ── procesare 1 ligă (refolosește deepdive_belarus) ──────────────────────────
def process_league(cur, lid, name, country, seasons):
    pre = DD.measure_poisson_vs_result(cur, lid, seasons)
    live = DD.measure_live_modules(cur, lid)
    mkt = market_rps_league(cur, lid, seasons)

    def pick(mod):
        cand = [live[k] for k in live if k[0] == mod]
        return max(cand, key=lambda d: d["N"]) if cand else None

    return dict(lid=lid, name=name, country=country, pre=pre, mkt=mkt,
                ngp=pick("NGP"), over=pick("OVER15"), conf=pick("CONFIDENCE"))


# ── raport ───────────────────────────────────────────────────────────────────
def build_report(res, pool_early, pool_late, ngp_perleague, n_qual, seasons,
                 min_pre, min_live):
    L = []
    L.append("=" * 118)
    L.append(" DEEP-DIVE SWEEP — tipare ROBUSTE vs-realitate pe %d ligi   (sezoane %s)" % (n_qual, seasons))
    L.append(" selecție: ≥%d predicții pre-meci cu rezultat SAU ≥%d predicții live rezolvate" % (min_pre, min_live))
    L.append("=" * 118)

    # ── 1) TABEL per ligă ──
    L.append(" %-22s %5s %8s %7s %7s %6s | %6s %8s %7s %6s %6s | %6s %6s | %6s %6s" % (
        "ligă", "N_pre", "BrΔ%", "RPSΔ%", "ECEpre", "mkt", "NGP_N", "NGPΔ%", "ECEngp",
        "OV_N", "OVΔ%", "CF_N", "CFΔ%", "earlyH", "lateH"))
    L.append("-" * 118)
    rows_sorted = sorted(res, key=lambda r: (r["pre"] is None,
                         -(_dpct(r["pre"]["brier"], r["pre"]["brier_base"]) if r["pre"] else -999)))
    for r in rows_sorted:
        pre = r["pre"]; ngp = r["ngp"]; ov = r["over"]; cf = r["conf"]; mk = r["mkt"]
        npre = pre["N"] if pre else 0
        brd = _dpct(pre["brier"], pre["brier_base"]) if pre else None
        rpd = _dpct(pre["rps"], pre["rps_base"]) if pre else None
        unsure = "*" if (pre and npre < min_pre) else " "
        eH = lH = None
        if ngp and ngp.get("el"):
            eH, lH = 100*ngp["el"]["eh"], 100*ngp["el"]["lh"]
        L.append(" %-22s%1s%4s %8s %7s %7s %6s | %6s %8s %7s %6s %6s | %6s %6s | %6s %6s" % (
            (str(r["name"] or "")[:20] + "/" + str(r["country"] or "")[:1]) if r["name"] else "id%s" % r["lid"],
            unsure, npre if pre else "-",
            "%+.0f" % brd if brd is not None else "-",
            "%+.0f" % rpd if rpd is not None else "-",
            "%.3f" % pre["ece"] if pre else "-",
            ("%dvs%d" % (round(100*mk["rps_noi"]), round(100*mk["rps_mkt"]))) if mk else "-",
            ngp["N"] if ngp else "-",
            "%+.0f" % _dpct(ngp["brier"], ngp["brier_base"]) if ngp else "-",
            "%.3f" % ngp["ece"] if ngp else "-",
            ov["N"] if ov else "-",
            "%+.0f" % _dpct(ov["brier"], ov["brier_base"]) if ov else "-",
            cf["N"] if cf else "-",
            "%+.0f" % _dpct(cf["brier"], cf["brier_base"]) if cf else "-",
            "%.0f" % eH if eH is not None else "-",
            "%.0f" % lH if lH is not None else "-"))
    L.append("   (* = NESIGUR: N_pre < %d.  BrΔ%%/RPSΔ%% = îmbunătățire vs base-rate, + = skill.)" % min_pre)

    # ── 2) AGREGAT — 4 întrebări ──
    L.append("")
    L.append("=" * 118)
    L.append(" AGREGAT")
    L.append("=" * 118)
    pres = [r for r in res if r["pre"] and r["pre"]["N"] >= min_pre]

    # (A) PRE-MECI zona de încredere
    beat = [r for r in pres if r["pre"]["brier"] < r["pre"]["brier_base"] - 1e-4]
    trust = [r for r in beat if r["pre"]["ece"] < CAL_OK]
    over = [r for r in pres if r["pre"]["ece"] >= CAL_OK]
    deltas = [_dpct(r["pre"]["brier"], r["pre"]["brier_base"]) for r in pres]
    L.append("(A) PRE-MECI 1X2 (N_pre≥%d: %d ligi):" % (min_pre, len(pres)))
    L.append("    bat base-rate: %d/%d | ȘI calibrate (ECE<%.2f) = ZONĂ DE ÎNCREDERE: %d → %s" % (
        len(beat), len(pres), CAL_OK, len(trust),
        ", ".join("%s(%+.0f%%)" % (r["name"], _dpct(r["pre"]["brier"], r["pre"]["brier_base"])) for r in
                  sorted(trust, key=lambda r: -_dpct(r["pre"]["brier"], r["pre"]["brier_base"]))[:12]) or "—"))
    L.append("    median Δ Brier vs base-rate = %s%% | overconfident (ECE≥%.2f): %d ligi" % (
        ("%+.1f" % statistics.median(deltas)) if deltas else "n/a", CAL_OK, len(over)))

    # (B) EDGE PIAȚĂ
    mkts = [r for r in res if r["mkt"]]
    win = [r for r in mkts if r["mkt"]["rps_noi"] < r["mkt"]["rps_mkt"] - 1e-5]
    L.append("(B) EDGE PIAȚĂ (subset cu cote, N_market≥%d: %d ligi):" % (N_MKT_MIN, len(mkts)))
    if mkts:
        L.append("    batem piața în %d/%d ligi. Detaliu: %s" % (
            len(win), len(mkts),
            ", ".join("%s(noi %.3f vs %.3f, N=%d)" % (r["name"], r["mkt"]["rps_noi"], r["mkt"]["rps_mkt"], r["mkt"]["N"])
                      for r in sorted(mkts, key=lambda r: r["mkt"]["rps_noi"]-r["mkt"]["rps_mkt"])[:8]) or "—"))
        L.append("    ⚠ AVERTISMENT: N e MIC peste tot (max N_market=%d) — NU trage concluzii tari." % (
            max(r["mkt"]["N"] for r in mkts)))
    else:
        L.append("    nicio ligă cu ≥%d cote 1X2 — edge vs piață NEMĂSURABIL la scară." % N_MKT_MIN)

    # (C) RUPEREA NGP TÂRZIU (pooled)
    en, ep, er = pool_early; ln, lp, lr = pool_late
    deg = []
    n_late_leagues = 0
    for lid, ph in ngp_perleague.items():
        if "late" in ph and ph["late"][0] >= 200:
            n_late_leagues += 1
            n, pred, rate = ph["late"]
            if pred - rate > 0.05:    # overconfident târziu
                deg.append((lid, n, pred-rate))
    L.append("(C) RUPEREA NGP TÂRZIU — POOLED pe toate ligile:")
    L.append("    early(≤60'): N=%d pred_mediu=%.1f%% rată_reală=%.1f%% gap=%+.1f pp" % (
        en, 100*ep, 100*er, 100*(ep-er)))
    L.append("    late (>60'): N=%d pred_mediu=%.1f%% rată_reală=%.1f%% gap=%+.1f pp" % (
        ln, 100*lp, 100*lr, 100*(lp-lr)))
    L.append("    degradare reală (late_N≥200 ȘI pred−real>5pp): %d/%d ligi" % (len(deg), n_late_leagues))
    gen = (lp - lr) - (ep - er)    # cât mai mare e gap-ul târziu față de devreme (pooled)
    if gen > 0.03:
        vc = ("GENERALĂ — ruptura târziu apare POOLED (+%.1f pp), confirmată în %d/%d ligi" % (
            100*gen, len(deg), n_late_leagues))
    elif gen > 0.01:
        vc = ("UȘOARĂ/PARȚIALĂ — gap pooled +%.1f pp, vizibilă în %d/%d ligi" % (
            100*gen, len(deg), n_late_leagues))
    else:
        vc = "ABSENTĂ/SPECIFICĂ — fără tipar pooled (gap pooled %+.1f pp)" % (100*gen)
    L.append("    VERDICT: %s" % vc)

    # (D) MODULE CU SKILL CONSISTENT
    L.append("(D) MODULE CU SKILL CONSISTENT (în câte ligi bat base-rate):")
    for mod, key in [("NGP", "ngp"), ("OVER15", "over"), ("CONFIDENCE", "conf")]:
        have = [r for r in res if r[key]]
        beats = [r for r in have if r[key]["brier"] < r[key]["brier_base"] - 1e-4]
        calib = [r for r in beats if r[key]["ece"] < CAL_OK]
        L.append("    %-11s bate base-rate în %d/%d ligi (din care calibrate: %d)%s" % (
            mod, len(beats), len(have), len(calib),
            "" if mod in DD.EVENT_PROB_MODULES else "  [confidență direcțională — orientativ]"))

    L.append("=" * 118)
    L.append(" STRICT READ-ONLY: zero scrieri în DB, zero producție atinsă.")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser(description="Sweep multi-ligă vs realitate (read-only).")
    ap.add_argument("--seasons", type=str, default=",".join(str(s) for s in SEASONS_DEFAULT))
    ap.add_argument("--min-prematch", type=int, default=MIN_PRE_DEFAULT, dest="min_pre")
    ap.add_argument("--min-live", type=int, default=MIN_LIVE_DEFAULT, dest="min_live")
    ap.add_argument("--limit", type=int, default=None, help="procesează doar primele N ligi (test rapid)")
    args = ap.parse_args()
    seasons = [int(s) for s in args.seasons.split(",") if s.strip()]

    conn = B.get_conn(); cur = conn.cursor()
    ids, prec, livec, meta = qualified_leagues(cur, args.min_pre, args.min_live)
    print("Ligi calificate: %d (≥%d pre-meci SAU ≥%d live)." % (len(ids), args.min_pre, args.min_live))
    if not ids:
        print("Nicio ligă calificată."); sys.exit(2)
    if args.limit:
        ids = ids[:args.limit]
        print("--limit %d → procesez %d ligi." % (args.limit, len(ids)))

    res = []
    for i, lid in enumerate(ids):
        name, country = meta.get(lid, ("id%s" % lid, None))
        try:
            res.append(process_league(cur, lid, name, country, seasons))
        except Exception as ex:
            try: conn.rollback()
            except Exception: pass
            print("  [skip %s: %s]" % (lid, str(ex).splitlines()[0][:80]))
        if (i + 1) % 10 == 0:
            print("  ...%d/%d ligi" % (i + 1, len(ids)), flush=True)

    pool_early, pool_late, ngp_perleague = ngp_phase_pooled(cur, ids)
    cur.close(); conn.close()

    report = build_report(res, pool_early, pool_late, ngp_perleague, len(ids), seasons,
                          args.min_pre, args.min_live)
    print(report)
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "deepdive_sweep_report.txt")
    try:
        with open(path, "w") as fh:
            fh.write(report + "\n")
        print("\n[raport salvat] %s" % path)
    except Exception as ex:
        print("\n[nu am putut salva: %s]" % ex)


if __name__ == "__main__":
    main()
