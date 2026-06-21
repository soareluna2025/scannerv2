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


# ── rezolvare ligă (robustă: name + country + aliasuri) ──────────────────────
# aliasuri per cheie de țară/ligă (case-insensitive, fragmente LIKE)
LEAGUE_ALIASES = {
    "belarus": ["belarus", "belarusian", "vysshaya", "vysheyshaya", "vyshava",
                "wysschaja", "belarus premier", "belarusian premier", "high league"],
}


def _resolve_query(cur, patterns):
    """Caută în name SAU country (lower LIKE) pe o listă de fragmente. Robust dacă
    lipsește coloana country (fallback name-only)."""
    pats = list(patterns)
    rows = _qall(cur,
        "SELECT league_id, name, country, tier FROM leagues "
        "WHERE EXISTS (SELECT 1 FROM unnest(%s::text[]) p "
        "             WHERE lower(name) LIKE p OR lower(COALESCE(country,'')) LIKE p) "
        "ORDER BY COALESCE(tier,9), league_id", (pats,))
    if rows and rows[0][0] == "ERR":   # ex. country lipsă → name-only
        rows = _qall(cur,
            "SELECT league_id, name, country, tier FROM leagues "
            "WHERE EXISTS (SELECT 1 FROM unnest(%s::text[]) p WHERE lower(name) LIKE p) "
            "ORDER BY league_id", (pats,))
    return rows


def resolve_league(cur, name, lid):
    """Întoarce (status, rows). status: 'ok' (≥1 potrivire), 'none' (0)."""
    if lid is not None:
        rows = _qall(cur, "SELECT league_id, name, country, tier FROM leagues WHERE league_id=%s", (lid,))
        return ("ok" if rows and rows[0][0] != "ERR" else "none", rows)
    term = (name or "").strip().lower()
    pats = set()
    if term:
        pats.add("%" + term + "%")
    for key, al in LEAGUE_ALIASES.items():
        if key in term or term in key:
            pats |= set("%" + a + "%" for a in al)
    if not pats:
        pats.add("%")
    rows = _resolve_query(cur, pats)
    rows = [r for r in rows if r and r[0] != "ERR"]
    return ("ok" if rows else "none", rows)


def list_all_played_leagues(cur):
    """Fallback: toate ligile care AU meciuri în fixtures_history (id|name|country|N)."""
    return _qall(cur,
        "SELECT l.league_id, l.name, l.country, COUNT(fh.fixture_id) AS n "
        "  FROM leagues l JOIN fixtures_history fh ON fh.league_id = l.league_id "
        " GROUP BY l.league_id, l.name, l.country HAVING COUNT(fh.fixture_id) > 0 "
        " ORDER BY l.country NULLS LAST, l.name")


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


# ── „NOI vs REALITATE" (fără piață) — miezul pe Belarus ───────────────────────
EVENT_PROB_MODULES = {"NGP", "OVER15", "OVER25", "GG"}   # predicted_value = P(eveniment=WIN)


def multiclass_brier(P, O):
    return float(np.mean(np.sum((P - O) ** 2, axis=1)))


def _bucket_table(p, y, bins=10):
    """Decile de probabilitate prezisă: (lo, hi, n, pred_mediu, rată_reală)."""
    edges = np.linspace(0, 1, bins + 1)
    out = []
    for b in range(bins):
        lo, hi = edges[b], edges[b + 1]
        m = (p >= lo) & (p < hi if b < bins - 1 else p <= hi)
        n = int(m.sum())
        out.append((lo, hi, n,
                    float(p[m].mean()) if n else float("nan"),
                    float(y[m].mean()) if n else float("nan")))
    return out


def _ece_from_buckets(buckets, N):
    return sum(abs(pm - rl) * n / N for lo, hi, n, pm, rl in buckets if n > 0)


def skill_verdict(brier, brier_base):
    if brier_base <= 1e-9:
        return "n/a"
    impr = (brier_base - brier) / brier_base * 100
    if brier < brier_base - 1e-4:
        return "BATE base-rate (+%.0f%%)" % impr
    if brier > brier_base + 1e-4:
        return "SUB base-rate (%.0f%%)" % impr
    return "≈ base-rate"


def measure_poisson_vs_result(cur, lid, seasons):
    """PRE-MECI Poisson 1X2 vs REZULTAT real (NU cere cote — merge și fără piață)."""
    sql = """SELECT fh.home_goals, fh.away_goals, p.home_win_prob, p.draw_prob, p.away_win_prob
               FROM fixtures_history fh JOIN predictions p ON p.fixture_id=fh.fixture_id
              WHERE fh.league_id=%s AND fh.home_goals IS NOT NULL AND fh.away_goals IS NOT NULL
                AND p.home_win_prob IS NOT NULL AND p.draw_prob IS NOT NULL AND p.away_win_prob IS NOT NULL
                AND fh.season = ANY(%s)"""
    rows = _qall(cur, sql, (lid, list(seasons)))
    if not rows or rows[0][0] == "ERR" or len(rows) < 5:
        return None
    P, outs = [], []
    for hg, ag, ph, pd, pa in rows:
        P.append([float(ph), float(pd), float(pa)])
        outs.append(0 if hg > ag else (1 if hg == ag else 2))
    P = B.normalize(np.array(P, float)); outs = np.array(outs)
    O = np.zeros_like(P); O[np.arange(len(outs)), outs] = 1
    base = np.bincount(outs, minlength=3) / len(outs)
    Bb = np.tile(base, (len(outs), 1))
    rel = _bucket_table(P.max(1), (P.argmax(1) == outs).astype(float))
    return dict(N=len(P), brier=multiclass_brier(P, O), brier_base=multiclass_brier(Bb, O),
                rps=float(B.rps(P, O).mean()), rps_base=float(B.rps(Bb, O).mean()),
                acc=float((P.argmax(1) == outs).mean()), acc_base=float(base.max()),
                ece=ece_top1(P, outs), base=base.tolist(), reliability=rel)


def measure_live_modules(cur, lid):
    """Fiecare modul rezolvat din prediction_log vs REZULTAT (NU vs piață): per (modul, fază)."""
    sql = """SELECT module, COALESCE(minute,0) AS minute, predicted_value, outcome
               FROM prediction_log
              WHERE league_id=%s AND outcome IN ('WIN','LOSS') AND predicted_value IS NOT NULL"""
    rows = _qall(cur, sql, (lid,))
    if not rows or rows[0][0] == "ERR":
        return {}
    agg = {}
    for module, minute, pv, outcome in rows:
        phase = "live" if (minute or 0) > 0 else "pre"
        d = agg.setdefault((str(module), phase), {"p": [], "y": [], "min": []})
        d["p"].append(float(pv) / 100.0)
        d["y"].append(1.0 if outcome == "WIN" else 0.0)
        d["min"].append(int(minute or 0))
    res = {}
    for key, d in agg.items():
        module, phase = key
        p = np.array(d["p"]); y = np.array(d["y"]); mn = np.array(d["min"]); N = len(p)
        base = float(y.mean())
        buckets = _bucket_table(p, y)
        el = None
        if phase == "live":
            early, late = mn <= 60, mn > 60
            if early.sum() >= 20 and late.sum() >= 20:
                el = dict(en=int(early.sum()), eh=float(y[early].mean()),
                          ln=int(late.sum()), lh=float(y[late].mean()))
        res[key] = dict(N=N, brier=float(np.mean((p - y) ** 2)),
                        brier_base=float(base * (1 - base)), base=base,
                        acc=float(((p >= 0.5).astype(float) == y).mean()),
                        ece=_ece_from_buckets(buckets, N), mean_pred=float(p.mean()),
                        is_prob=(module in EVENT_PROB_MODULES), buckets=buckets, el=el)
    return res


def _fmt_reliability(buckets, label="p prezis"):
    lines = ["   %-12s %8s %12s %12s" % ("bucket " + label, "n", "pred_mediu", "rată_reală")]
    for lo, hi, n, pm, rl in buckets:
        if n == 0:
            lines.append("   %4.1f-%4.1f      %8d %12s %12s" % (lo, hi, n, "-", "-"))
        else:
            lines.append("   %4.1f-%4.1f      %8d %12.3f %12.3f" % (lo, hi, n, pm, rl))
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="Disecție ligă pe toate creierele vs Bet365 (read-only).")
    ap.add_argument("--league", type=str, default="Belarus")
    ap.add_argument("--league-id", type=int, default=None, dest="league_id")
    ap.add_argument("--seasons", type=str, default=",".join(str(s) for s in SEASONS_DEFAULT))
    ap.add_argument("--phase0", action="store_true", help="doar inventarul (fără măsurători)")
    args = ap.parse_args()
    seasons = [int(s) for s in args.seasons.split(",") if s.strip()]

    conn = B.get_conn(); cur = conn.cursor()
    status, cands = resolve_league(cur, args.league, args.league_id)

    if status != "ok" or not cands:
        # liga NU există pt termenul dat → arătăm clar + listă de ales manual
        print("✗ LIGA NU EXISTĂ în `leagues` pentru '%s'%s (căutat în name ȘI country + aliasuri)." % (
            args.league, "" if args.league_id is None else " / id=%s" % args.league_id))
        allp = list_all_played_leagues(cur)
        if allp and allp[0][0] != "ERR":
            print("\nLigi cu meciuri în fixtures_history (alege cu --league-id N):")
            print("   %-7s %-34s %-18s %s" % ("id", "name", "country", "N_meciuri"))
            for r in allp:
                print("   %-7s %-34s %-18s %s" % (r[0], str(r[1])[:34], str(r[2] or "")[:18], r[3]))
        else:
            print("   (nu am putut lista ligile cu meciuri: %s)" % allp)
        cur.close(); conn.close(); sys.exit(2)

    if len(cands) > 1:
        print("✓ Mai multe ligi potrivite pt '%s' — alege cu --league-id:" % args.league)
        print("   %-7s %-34s %-18s %s" % ("id", "name", "country", "tier"))
        for c in cands:
            print("   %-7s %-34s %-18s %s" % (c[0], str(c[1])[:34], str(c[2] or "")[:18], c[3]))
        cur.close(); conn.close(); sys.exit(0)

    lid, lname, lcountry, ltier = cands[0]
    print("✓ Ligă rezolvată: id=%s | %s | %s | tier=%s" % (lid, lname, lcountry, ltier))
    meta = {"league_id": lid, "name": lname, "country": lcountry, "tier": ltier}
    slug = re.sub(r"[^a-z0-9]+", "_", str(lname).lower()).strip("_")[:30] or "league"

    inv = phase0(cur, lid)
    blocks = [print_phase0(meta, inv)]

    if not args.phase0:
        # MARKET disponibil? (Belarus: 0 cote → toată comparația vs piață e N/A)
        mkt_avail = _num(inv.get("odds_b365_1x2")) > 0
        pois_mkt = measure_poisson_1x2(cur, lid, seasons) if mkt_avail else None

        # MIEZUL: NOI vs REALITATE (fără piață)
        pvr = measure_poisson_vs_result(cur, lid, seasons)
        live = measure_live_modules(cur, lid)

        T = []
        T.append("=" * 92)
        T.append(" FAZA 2 — NOI vs REALITATE pe %s (id=%s)   ·   PIAȚĂ: %s" % (
            meta["name"], lid, "disponibilă" if mkt_avail else "INDISPONIBILĂ — 0 cote Bet365"))
        T.append("=" * 92)

        # ── PRE-MECI Poisson 1X2 vs rezultat ──
        T.append("── PRE-MECI · Poisson 1X2 vs REZULTAT (fixtures_history) ──")
        if not pvr:
            T.append("   NEMĂSURABIL — sub 5 meciuri cu predicție 1X2 + rezultat.")
        else:
            b = pvr
            T.append("   N=%d" % b["N"])
            T.append("   Brier mc : %.5f   | base-rate: %.5f   → %s" % (
                b["brier"], b["brier_base"], skill_verdict(b["brier"], b["brier_base"])))
            T.append("   RPS      : %.5f   | base-rate: %.5f   → %s" % (
                b["rps"], b["rps_base"], skill_verdict(b["rps"], b["rps_base"])))
            T.append("   Acuratețe: %.1f%%    | base-rate(majoritate): %.1f%%" % (
                100 * b["acc"], 100 * b["acc_base"]))
            T.append("   ECE(top-1): %.4f   | base-rate reală H/D/A = %.0f/%.0f/%.0f%%" % (
                b["ece"], 100 * b["base"][0], 100 * b["base"][1], 100 * b["base"][2]))
            T.append("   reliability (top-1 încredere):")
            T.append(_fmt_reliability(b["reliability"], "încredere"))
            if mkt_avail and pois_mkt:
                T.append("   [vs piață] RPS noi %.5f vs Bet365 %.5f (%s)" % (
                    pois_mkt["rps"], pois_mkt["rps_mkt"], _verdict(pois_mkt["rps"], pois_mkt["rps_mkt"])))
            else:
                T.append("   [vs piață] N/A — 0 cote Bet365 pe ligă.")

        # ── LIVE + alte module din prediction_log ──
        T.append("")
        T.append("── LIVE / MOTOR · module prediction_log vs REZULTAT (base-rate OBLIGATORIU lângă Brier) ──")
        if not live:
            T.append("   (niciun modul rezolvat pe ligă)")
        else:
            order = sorted(live.keys(), key=lambda k: (k[1] != "live", k[0]))   # live întâi
            for key in order:
                module, phase = key
                d = live[key]
                tag = "" if d["is_prob"] else "  [confidență direcțională — Brier orientativ]"
                T.append("  • %-10s [%-4s] N=%-6d  pred_mediu=%.1f%%  rată_reală=%.1f%%%s" % (
                    module, phase, d["N"], 100 * d["mean_pred"], 100 * d["base"], tag))
                T.append("      Brier=%.4f | base-rate=%.4f → %s | acc(@.5)=%.1f%% | ECE=%.4f" % (
                    d["brier"], d["brier_base"], skill_verdict(d["brier"], d["brier_base"]),
                    100 * d["acc"], d["ece"]))
                if d["el"]:
                    e = d["el"]
                    T.append("      fază: devreme(≤60') n=%d hit=%.1f%%  vs  târziu(>60') n=%d hit=%.1f%%" % (
                        e["en"], 100 * e["eh"], e["ln"], 100 * e["lh"]))
                T.append("      calibrare (decile prob prezisă — cand zice X%, se intampla ~X%?):")
                T.append(_fmt_reliability(d["buckets"], "prob"))

        # ── alte creiere (status) ──
        T.append("")
        T.append("── ALTE CREIERE ──")
        T.append("   (b) ML pre-meci 1X2: NEMĂSURABIL (nelogat).  ↳ API-Football 1X2: %s" % (
            "vezi mai jos" if mkt_avail else "N/A fără piață (e benchmark vs cote)"))
        T.append("   (c/d) LIVE vs Bet365 live: NEMĂSURABIL — nu stocăm cote live/inplay.")
        T.append("   (e) DL/GRU next-goal: PARȚIAL — necesită extract+train Belarus (alt branch, GPU).")

        # ── SUMAR ──
        T.append("")
        T.append("── SUMAR (cât de bun e motorul pe %s, în ABSOLUT) ──" % meta["name"])
        if pvr:
            T.append("  • PRE-MECI 1X2: Brier %.4f vs base-rate %.4f → %s (RPS %.4f vs %.4f). %s." % (
                pvr["brier"], pvr["brier_base"], skill_verdict(pvr["brier"], pvr["brier_base"]),
                pvr["rps"], pvr["rps_base"],
                "calibrat OK" if pvr["ece"] < 0.05 else "calibrare de îmbunătățit (ECE %.3f)" % pvr["ece"]))
        else:
            T.append("  • PRE-MECI 1X2: nemăsurabil.")
        if live:
            beats = [("%s/%s" % k) for k, d in live.items() if d["is_prob"] and d["brier"] < d["brier_base"] - 1e-4]
            loses = [("%s/%s" % k) for k, d in live.items() if d["is_prob"] and d["brier"] > d["brier_base"] + 1e-4]
            T.append("  • LIVE — module cu SKILL (bat base-rate): %s" % (", ".join(beats) or "niciunul"))
            T.append("  • LIVE — module FĂRĂ skill (≤ base-rate): %s" % (", ".join(loses) or "niciunul"))
            wc = [k for k, d in live.items() if d["is_prob"] and d["ece"] > 0.05]
            T.append("  • Calibrare slabă (ECE>0.05): %s" % (", ".join("%s/%s" % k for k in wc) or "—"))
        T.append("  • Piață: %s." % ("disponibilă" if mkt_avail else "indisponibilă (0 cote) — comparația e cu REALITATEA, nu cu casa"))
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
