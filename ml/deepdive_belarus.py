#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
deepdive_belarus.py — DISECȚIE COMPLETĂ a UNEI ligi pe toate „creierele" vs Bet365.
Parametrizat: --league "Belarus"  sau  --league-id N. STRICT READ-ONLY (zero scrieri DB).

NU atinge calcPoisson6x6 / Maher / Monte Carlo / ml/calibrate.py / producția.
REFOLOSEȘTE loader-ul + RPS din ml/benchmark_rps.py (pre-meci 1X2). Honest: măsoară DOAR ce
există în date; ce n-are date e marcat „NEMĂSURABIL — lipsesc date X".

FAZA 0 (--phase0 sau mereu la început): inventar & fezabilitate per creier.
FAZA 1: disecția pe ce-i măsurabil. FAZA 2: tabel consolidat + salvare în
ml/deepdive_<slug>_report.txt.

Rulare:
  python3 ml/deepdive_belarus.py --league "Belarus"
  python3 ml/deepdive_belarus.py --league-id 116 --phase0
"""

import os
import re
import sys
import argparse

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import benchmark_rps as B   # loader pre-meci + RPS/logloss/accuracy/normalize (refolosite)

SEASONS_DEFAULT = [2021, 2022, 2023, 2024, 2025, 2026]
BOOK = B.BOOKMAKER_ID       # 8 = Bet365
ELITE, HOUSE = 0.19, 0.21


# ── helpers metrici ──────────────────────────────────────────────────────────
def ece_top1(probs, out, bins=10):
    conf = probs.max(axis=1); pred = probs.argmax(axis=1)
    correct = (pred == out).astype(float)
    edges = np.linspace(0, 1, bins + 1); e = 0.0; N = len(out)
    for b in range(bins):
        lo, hi = edges[b], edges[b + 1]
        m = (conf >= lo) & (conf < hi if b < bins - 1 else conf <= hi)
        if m.sum() > 0:
            e += abs(float(conf[m].mean()) - float(correct[m].mean())) * int(m.sum()) / N
    return e


def _q1(cur, sql, params=()):
    """SELECT scalar read-only, robust la tabele lipsă."""
    try:
        cur.execute(sql, params)
        r = cur.fetchone()
        return r[0] if r else None
    except Exception as ex:
        try:
            cur.connection.rollback()
        except Exception:
            pass
        return "ERR:%s" % str(ex).splitlines()[0][:60]


def _qall(cur, sql, params=()):
    try:
        cur.execute(sql, params)
        return cur.fetchall()
    except Exception as ex:
        try:
            cur.connection.rollback()
        except Exception:
            pass
        return [("ERR", str(ex).splitlines()[0][:60])]


# ── rezolvare ligă ───────────────────────────────────────────────────────────
def resolve_league(cur, name, lid):
    if lid is not None:
        rows = _qall(cur, "SELECT league_id, name, country, tier FROM leagues WHERE league_id=%s", (lid,))
    else:
        rows = _qall(cur,
            "SELECT league_id, name, country, tier FROM leagues WHERE name ILIKE %s OR name ILIKE %s ORDER BY league_id",
            ("%" + name + "%", "%vysshaya%"))
    return rows


# ── FAZA 0 — inventar ────────────────────────────────────────────────────────
def phase0(cur, lid):
    out = {}
    # mulțime de fixture_id ale ligii (din ambele tabele de meciuri)
    fx_cte = ("(SELECT fixture_id FROM fixtures_history WHERE league_id=%s "
              "UNION SELECT fixture_id FROM fixtures WHERE league_id=%s)")
    out["fh_n"] = _q1(cur, "SELECT COUNT(*) FROM fixtures_history WHERE league_id=%s AND home_goals IS NOT NULL", (lid,))
    out["fh_span"] = _qall(cur, "SELECT MIN(season), MAX(season), MIN(match_date)::date, MAX(match_date)::date FROM fixtures_history WHERE league_id=%s", (lid,))
    out["pred_1x2"] = _q1(cur, "SELECT COUNT(*) FROM predictions WHERE league_id=%s AND home_win_prob IS NOT NULL AND draw_prob IS NOT NULL AND away_win_prob IS NOT NULL", (lid,))
    out["pred_api"] = _q1(cur, "SELECT COUNT(*) FROM predictions WHERE league_id=%s AND api_home_pct IS NOT NULL AND api_draw_pct IS NOT NULL AND api_away_pct IS NOT NULL", (lid,))
    # cote: Bet365 1X2 pre-meci (toate 3 prezente) + alte piețe Bet365 + alți bookmakeri
    out["odds_b365_1x2"] = _q1(cur,
        "SELECT COUNT(*) FROM (SELECT o.fixture_id FROM odds o WHERE o.bookmaker_id=%s AND o.bet_name='Match Winner' "
        "AND o.fixture_id IN " + fx_cte + " GROUP BY o.fixture_id HAVING COUNT(DISTINCT o.value_name)>=3) q",
        (BOOK, lid, lid))
    out["odds_b365_markets"] = _qall(cur,
        "SELECT bet_name, COUNT(DISTINCT fixture_id) FROM odds WHERE bookmaker_id=%s AND fixture_id IN " + fx_cte +
        " GROUP BY bet_name ORDER BY 2 DESC LIMIT 12", (BOOK, lid, lid))
    out["odds_other_books"] = _qall(cur,
        "SELECT bookmaker_id, bookmaker_name, COUNT(DISTINCT fixture_id) FROM odds WHERE bookmaker_id<>%s AND fixture_id IN " + fx_cte +
        " GROUP BY bookmaker_id, bookmaker_name ORDER BY 3 DESC LIMIT 8", (BOOK, lid, lid))
    out["me_n"] = _q1(cur, "SELECT COUNT(*) FROM match_events WHERE fixture_id IN " + fx_cte, (lid, lid))
    out["me_fix"] = _q1(cur, "SELECT COUNT(DISTINCT fixture_id) FROM match_events WHERE fixture_id IN " + fx_cte, (lid, lid))
    out["ls_n"] = _q1(cur, "SELECT COUNT(*) FROM live_stats WHERE fixture_id IN " + fx_cte, (lid, lid))
    out["ls_fix"] = _q1(cur, "SELECT COUNT(DISTINCT fixture_id) FROM live_stats WHERE fixture_id IN " + fx_cte, (lid, lid))
    out["ls_xg"] = _q1(cur, "SELECT COUNT(*) FROM live_stats WHERE home_xg IS NOT NULL AND fixture_id IN " + fx_cte, (lid, lid))
    out["mlf_n"] = _q1(cur, "SELECT COUNT(*) FROM ml_features WHERE fixture_id IN " + fx_cte, (lid, lid))
    # prediction_log pe ligă, defalcat pe modul + pre/live (minute>0=live) + rezolvate
    out["predlog"] = _qall(cur,
        "SELECT module, COUNT(*) AS n, COUNT(*) FILTER (WHERE COALESCE(minute,0)>0) AS live_n, "
        "COUNT(*) FILTER (WHERE outcome IN ('WIN','LOSS')) AS resolved FROM prediction_log "
        "WHERE league_id=%s GROUP BY module ORDER BY 2 DESC", (lid,))
    return out


def print_phase0(meta, inv):
    L = []
    L.append("=" * 92)
    L.append(" DEEP-DIVE — FAZA 0 INVENTAR  ·  ligă: %s (id=%s, %s, tier=%s)" % (
        meta["name"], meta["league_id"], meta["country"], meta["tier"]))
    L.append("=" * 92)
    sp = inv["fh_span"][0] if inv["fh_span"] else (None,)*4
    L.append(" fixtures_history (cu rezultat): N=%s | sezoane %s..%s | %s..%s" % (
        inv["fh_n"], sp[0], sp[1], sp[2], sp[3]))
    L.append(" predictions 1X2 Poisson (home/draw/away_win_prob): %s" % inv["pred_1x2"])
    L.append(" predictions 1X2 API-Football (api_*_pct):          %s" % inv["pred_api"])
    L.append(" odds Bet365 1X2 pre-meci (toate 3, bookmaker %d):  %s fixturi" % (BOOK, inv["odds_b365_1x2"]))
    L.append(" odds Bet365 — piețe disponibile (top):")
    for r in inv["odds_b365_markets"]:
        L.append("     · %-26s %s fixturi" % (str(r[0])[:26], r[1]))
    L.append(" odds alți bookmakeri: %s" % (
        ", ".join("%s=%s(%s fx)" % (r[0], str(r[1])[:14], r[2]) for r in inv["odds_other_books"]) or "—"))
    L.append(" match_events: %s rânduri / %s fixturi | live_stats: %s rânduri / %s fixturi (xG-rows=%s)" % (
        inv["me_n"], inv["me_fix"], inv["ls_n"], inv["ls_fix"], inv["ls_xg"]))
    L.append(" ml_features: %s rânduri" % inv["mlf_n"])
    L.append(" prediction_log pe ligă (module | n | din care live | rezolvate):")
    for r in inv["predlog"]:
        L.append("     · %-12s n=%-6s live=%-6s resolved=%-6s" % (r[0], r[1], r[2], r[3]))
    L.append("-" * 92)
    L.append(" HARTĂ FEZABILITATE (din date REALE de mai sus):")
    fmt = "   %-26s %-13s %s"
    L.append(fmt % ("(a) Poisson pre-meci 1X2", _fz(inv["pred_1x2"], inv["odds_b365_1x2"]),
                    "predictions+odds Bet365+rezultat → vs piață"))
    L.append(fmt % ("(b) ML pre-meci 1X2", "NEMĂSURABIL",
                    "nu se loghează probe ML 1X2 (prediction_log = doar OVER/GG/CONF/NGP)"))
    L.append(fmt % ("    ↳ API-Football 1X2 (bonus)", _fz(inv["pred_api"], inv["odds_b365_1x2"]),
                    "creier EXTERN (nu al nostru) → vs piață, dacă populat"))
    L.append(fmt % ("(c) Motor LIVE vs Bet365live", "NEMĂSURABIL",
                    "nu stocăm cote live/inplay (doar /odds pre-meci)"))
    L.append(fmt % ("    ↳ Motor LIVE vs rezultat", _fz(inv["predlog"], 1, is_list=True),
                    "prediction_log NGP/OVER live rezolvat → Brier/acc (fără piață)"))
    L.append(fmt % ("(d) ML live vs Bet365live", "NEMĂSURABIL", "idem (c): fără cote live stocate"))
    L.append(fmt % ("(e) DL/GRU next-goal", "PARȚIAL",
                    "experiment_live_sequence pe alt branch, fără filtru ligă/checkpoint Belarus"))
    L.append("=" * 92)
    return "\n".join(L)


def _fz(a, b, is_list=False):
    """verdict scurt de fezabilitate din numere."""
    if is_list:
        ok = any(isinstance(r, (list, tuple)) and str(r[0]) not in ("ERR",) and _num(r[1]) and _num(r[3]) for r in a)
        return "MĂSURABIL" if ok else "NEMĂSURABIL"
    na, nb = _num(a), _num(b)
    if na and nb and na > 0 and nb > 0:
        return "MĂSURABIL" if min(na, nb) >= 30 else "PARȚIAL(N mic)"
    return "NEMĂSURABIL"


def _num(x):
    try:
        return int(x)
    except Exception:
        return 0


# ── FAZA 1 — măsurători ──────────────────────────────────────────────────────
def measure_poisson_1x2(cur, lid, seasons):
    rows = [r for r in B.fetch_rows(cur, seasons, BOOK) if int(r["league_id"]) == int(lid)]
    if len(rows) < 5:
        return None
    P, M, O, ssn, lg, out = B.build_arrays(rows)
    return dict(N=len(P),
                rps=float(B.rps(P, O).mean()), rps_mkt=float(B.rps(M, O).mean()),
                ll=B.logloss(P, O), ll_mkt=B.logloss(M, O),
                acc=B.accuracy(P, O), acc_mkt=B.accuracy(M, O),
                ece=ece_top1(P, out), ece_mkt=ece_top1(M, out))


def measure_api_1x2(cur, lid, seasons):
    """Creier EXTERN API-Football (api_*_pct) vs Bet365 — aceleași meciuri/loader-style."""
    sql = """
      SELECT fh.home_goals, fh.away_goals,
             p.api_home_pct, p.api_draw_pct, p.api_away_pct,
             MAX(o.value_odd) FILTER (WHERE o.value_name='Home') AS oh,
             MAX(o.value_odd) FILTER (WHERE o.value_name='Draw') AS od,
             MAX(o.value_odd) FILTER (WHERE o.value_name='Away') AS oa
        FROM fixtures_history fh
        JOIN predictions p ON p.fixture_id=fh.fixture_id
        JOIN odds o ON o.fixture_id=fh.fixture_id AND o.bookmaker_id=%s
                   AND o.bet_name='Match Winner' AND o.value_name IN ('Home','Draw','Away')
       WHERE fh.league_id=%s AND fh.home_goals IS NOT NULL AND fh.away_goals IS NOT NULL
         AND p.api_home_pct IS NOT NULL AND p.api_draw_pct IS NOT NULL AND p.api_away_pct IS NOT NULL
         AND fh.season = ANY(%s)
       GROUP BY fh.fixture_id, fh.home_goals, fh.away_goals, p.api_home_pct, p.api_draw_pct, p.api_away_pct
      HAVING COUNT(DISTINCT o.value_name)=3 AND MIN(o.value_odd)>1.0
    """
    rows = _qall(cur, sql, (BOOK, lid, list(seasons)))
    if not rows or (rows and rows[0][0] == "ERR") or len(rows) < 5:
        return None
    P, M, O, outs = [], [], [], []
    for hg, ag, ah, ad, aa, oh, od, oa in rows:
        P.append([float(ah), float(ad), float(aa)])
        M.append([1/float(oh), 1/float(od), 1/float(oa)])
        o = 0 if hg > ag else (1 if hg == ag else 2)
        outs.append(o)
    P = B.normalize(np.array(P, float)); M = B.normalize(np.array(M, float))
    O = np.zeros_like(P); O[np.arange(len(outs)), outs] = 1
    outs = np.array(outs)
    return dict(N=len(P), rps=float(B.rps(P, O).mean()), rps_mkt=float(B.rps(M, O).mean()),
                ll=B.logloss(P, O), ll_mkt=B.logloss(M, O),
                acc=B.accuracy(P, O), acc_mkt=B.accuracy(M, O),
                ece=ece_top1(P, outs), ece_mkt=ece_top1(M, outs))


def measure_predlog_markets(cur, lid):
    """prediction_log rezolvat per modul (vs REZULTAT real — NU vs piață): Brier + win-rate."""
    sql = """
      SELECT module, COALESCE(minute,0)>0 AS live, predicted_value, outcome
        FROM prediction_log
       WHERE league_id=%s AND outcome IN ('WIN','LOSS') AND predicted_value IS NOT NULL
    """
    rows = _qall(cur, sql, (lid,))
    if not rows or (rows and rows[0][0] == "ERR"):
        return {}
    agg = {}
    for module, live, pv, outcome in rows:
        key = "%s/%s" % (module, "live" if live else "pre")
        d = agg.setdefault(key, {"p": [], "w": []})
        d["p"].append(float(pv) / 100.0)
        d["w"].append(1.0 if outcome == "WIN" else 0.0)
    res = {}
    for k, d in agg.items():
        p = np.array(d["p"]); w = np.array(d["w"])
        res[k] = dict(N=len(p), brier=float(np.mean((p - w) ** 2)), winrate=float(w.mean()))
    return res


def _verdict(noi, mkt):
    if noi is None or mkt is None:
        return "—"
    d = noi - mkt
    return "BATEM" if d < -1e-4 else ("PIERDEM" if d > 1e-4 else "egal")


def main():
    ap = argparse.ArgumentParser(description="Disecție ligă pe toate creierele vs Bet365 (read-only).")
    ap.add_argument("--league", type=str, default="Belarus")
    ap.add_argument("--league-id", type=int, default=None, dest="league_id")
    ap.add_argument("--seasons", type=str, default=",".join(str(s) for s in SEASONS_DEFAULT))
    ap.add_argument("--phase0", action="store_true", help="doar inventarul (fără măsurători)")
    args = ap.parse_args()
    seasons = [int(s) for s in args.seasons.split(",") if s.strip()]

    conn = B.get_conn(); cur = conn.cursor()
    cands = resolve_league(cur, args.league, args.league_id)
    if not cands or (cands and cands[0][0] == "ERR"):
        print("Liga negăsită pt '%s'/%s. Detaliu: %s" % (args.league, args.league_id, cands)); sys.exit(2)
    if len(cands) > 1:
        print("Mai multe ligi potrivite — alege cu --league-id:")
        for c in cands:
            print("   id=%s | %s | %s | tier=%s" % (c[0], c[1], c[2], c[3]))
        sys.exit(0)
    lid, lname, lcountry, ltier = cands[0]
    meta = {"league_id": lid, "name": lname, "country": lcountry, "tier": ltier}
    slug = re.sub(r"[^a-z0-9]+", "_", str(lname).lower()).strip("_")[:30] or "league"

    inv = phase0(cur, lid)
    blocks = [print_phase0(meta, inv)]

    if not args.phase0:
        # FAZA 1 — măsurători (doar ce-i măsurabil)
        pois = measure_poisson_1x2(cur, lid, seasons)
        api = measure_api_1x2(cur, lid, seasons)
        pl = measure_predlog_markets(cur, lid)

        T = []
        T.append("=" * 92)
        T.append(" FAZA 2 — TABEL CONSOLIDAT (1X2: RPS · alte piețe: Brier vs REZULTAT)")
        T.append("=" * 92)
        T.append(" %-30s %7s %11s %11s %9s %s" % ("creier", "N", "NOI", "Bet365", "Δ", "verdict"))
        T.append("-" * 92)

        def row1x2(label, m):
            if not m:
                T.append(" %-30s %7s %11s %11s %9s %s" % (label, "—", "—", "—", "—", "NEMĂSURABIL"))
                return
            T.append(" %-30s %7d %11.5f %11.5f %+9.5f %s  (RPS)" % (
                label, m["N"], m["rps"], m["rps_mkt"], m["rps"]-m["rps_mkt"], _verdict(m["rps"], m["rps_mkt"])))

        row1x2("(a) Poisson pre-meci 1X2", pois)
        row1x2("(b↳) API-Football 1X2 [extern]", api)
        T.append(" %-30s %7s %11s %11s %9s %s" % ("(b) ML pre-meci 1X2", "—", "—", "—", "—", "NEMĂSURABIL (nelogat)"))
        T.append("-" * 92)
        T.append(" PIEȚE prediction_log (Brier vs REZULTAT real — NU există cote Bet365 pe acestea/live):")
        if pl:
            for k in sorted(pl):
                d = pl[k]
                T.append("   %-26s N=%-6d Brier=%.4f  win-rate=%.1f%%" % (k, d["N"], d["brier"], 100*d["winrate"]))
        else:
            T.append("   (niciun modul rezolvat pe ligă)")
        T.append(" %-30s %s" % ("(c/d) LIVE vs Bet365 live", "NEMĂSURABIL — nu stocăm cote live/inplay"))
        T.append(" %-30s %s" % ("(e) DL/GRU next-goal", "PARȚIAL — necesită extract+train Belarus (alt branch, GPU)"))
        T.append("-" * 92)

        # sumar
        def vtxt(m):
            return "n/a" if not m else ("%.5f vs %.5f (%s)" % (m["rps"], m["rps_mkt"], _verdict(m["rps"], m["rps_mkt"])))
        T.append(" SUMAR:")
        T.append("  • PRE-MECI 1X2 Poisson: %s" % vtxt(pois))
        if pois:
            T.append("    interpretare: RPS %.5f [reper ~%.2f elită, ~%.2f casă]" % (pois["rps"], ELITE, HOUSE))
        T.append("  • PRE-MECI 1X2 API-Football (extern): %s" % vtxt(api))
        T.append("  • LIVE: măsurabil DOAR vs rezultat (Brier piețe prediction_log); vs Bet365 live = lipsesc cote.")
        T.append("  • DL/GRU: de evaluat separat (extract pe ligă + train) — vezi nota.")
        T.append("  • POTENȚIAL: pe pre-meci 1X2, Δ vs piață spune direct dacă liga merită push (sub 0 = batem).")
        T.append("=" * 92)
        T.append(" STRICT READ-ONLY: zero scrieri în DB, zero producție atinsă.")
        blocks.append("\n".join(T))

    cur.close(); conn.close()
    report = "\n".join(blocks)
    print(report)
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "deepdive_%s_report.txt" % slug)
    try:
        with open(path, "w") as fh:
            fh.write(report + "\n")
        print("\n[raport salvat] %s" % path)
    except Exception as ex:
        print("\n[nu am putut salva raportul: %s]" % ex)


if __name__ == "__main__":
    main()
