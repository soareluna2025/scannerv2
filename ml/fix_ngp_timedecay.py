#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_ngp_timedecay.py — EXPERIMENT OFFLINE (STRICT READ-ONLY) pt corecția supra-încrederii
NGP spre finalul meciului. NU atinge motorul live (calcNextGoal/calcConfidenceLive/Maher/
Monte Carlo/calibrateNgp) — doar CITEȘTE prediction_log și testează corecții pe hârtie.

────────────────────────────────────────────────────────────────────────────────
FAZA 0 (din cod, rezumat — vezi raportul de chat):
 • NGP-ul logat = predicted_value = calibrateNgp(calcNextGoal(f)) (cap ~83), logat când >70.
 • calcNextGoal: remXg = (txg/minut)·(90−minut); BOOST ×1.2 la ≥70', ×1.15 la ≥80';
   prob = 1−exp(−remXg). Fereastra = REST-OF-MATCH.
 • Outcome (adevăr) = WIN dacă goluri_finale_total > total_la_predicție (update-results.js)
   ⇒ tot REST-OF-MATCH ⇒ fereastra prezisă și adevărul SUNT aliniate.
 • Deci NU e orb la timp (folosește 90−minut), DAR boost-urile ×1.2/×1.15 umflă exact târziu,
   iar calibrateNgp e GLOBAL (nu condiționat de minut) ⇒ rămâne supra-încredere târzie.
 • Offline avem DOAR: minute, score_at_prediction, predicted_value(=ngp), outcome.
   NU avem txg/λ ⇒ corecțiile folosesc DOAR ngp + minut.

CORECȚII testate:
 (a) DE-BOOST principial: inversez ngp→remXg, împart la factorul de boost al minutului
     (1.2 dacă ≥70', 1.15 dacă ≥80'), recompun prob. EXACT pe banda 70-80 (pass-through în
     calibrateNgp), APROXIMATIV pe vârful capat 80-83. Folosește doar ngp+minut.
 (b) RECALIBRARE EMPIRICĂ condiționată de MINUT: izotonică ngp→outcome pe bucket-uri de minut,
     evaluată STRICT OUT-OF-SAMPLE cu 5-fold CV (fallback izotonică globală pt bucket-uri rare).
     Formula-agnostică, robustă.

FAZA 2: Brier+ECE global, gap(pred−real) pe faze (≤60'/>60'), calibrare pe decile devreme/târziu,
pt NGP brut vs (a) vs (b). Verdict.

Rulare:
  nice -n 19 python3 ml/fix_ngp_timedecay.py
  nice -n 19 python3 ml/fix_ngp_timedecay.py --league-id 116
"""

import os
import sys
import argparse

import numpy as np
from sklearn.isotonic import IsotonicRegression
from sklearn.model_selection import KFold

ENV_PATH = "/root/scannerv2/.env"
SEED = 1337
N_SPLITS = 5
MIN_BUCKET_TRAIN = 200            # sub atât → fallback izotonică globală
LATE_CUT = 60                    # ≤60' devreme, >60' târziu
# bucket-uri fine de minut (margini pt np.digitize) — dese la final unde e ruptura
MIN_EDGES = [30, 45, 60, 70, 75, 80, 85]


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


def fetch_ngp(cur, league_id):
    where = "AND league_id=%s" % int(league_id) if league_id else ""
    cur.execute(
        """SELECT minute, predicted_value, outcome
             FROM prediction_log
            WHERE module='NGP' AND outcome IN ('WIN','LOSS')
              AND predicted_value IS NOT NULL AND minute IS NOT NULL %s""" % where)
    mn, p, y = [], [], []
    for minute, pv, outcome in cur.fetchall():
        mn.append(int(minute)); p.append(float(pv) / 100.0); y.append(1.0 if outcome == "WIN" else 0.0)
    return np.array(mn), np.array(p), np.array(y)


# ── (a) DE-BOOST principial (doar ngp + minut) ───────────────────────────────
def deboost(p, minute):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    remxg = -np.log(1 - p)
    boost = np.where(minute >= 80, 1.15, np.where(minute >= 70, 1.20, 1.0))
    return 1 - np.exp(-(remxg / boost))


# ── (b) RECALIBRARE empirică condiționată de minut, OOS 5-fold CV ─────────────
def calibrate_minute_cv(p, y, minute, n_splits=N_SPLITS, seed=SEED):
    N = len(p)
    b = np.digitize(minute, MIN_EDGES)          # index bucket de minut
    cal = np.zeros(N, dtype=np.float64)
    kf = KFold(n_splits=min(n_splits, N) if N >= 2 else 1, shuffle=True, random_state=seed)
    if N < 2:
        return p.copy()
    for tr, te in kf.split(p):
        glob = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(p[tr], y[tr])
        for bk in np.unique(b):
            teb = te[b[te] == bk]
            if len(teb) == 0:
                continue
            trb = tr[b[tr] == bk]
            if len(trb) >= MIN_BUCKET_TRAIN:
                iso = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(p[trb], y[trb])
                cal[teb] = iso.predict(p[teb])
            else:
                cal[teb] = glob.predict(p[teb])   # fallback global
    return cal


# ── metrici ──────────────────────────────────────────────────────────────────
def brier(p, y):
    return float(np.mean((p - y) ** 2))


def ece(p, y, bins=10):
    edges = np.linspace(0, 1, bins + 1); e, N = 0.0, len(y)
    for i in range(bins):
        lo, hi = edges[i], edges[i + 1]
        m = (p >= lo) & (p < hi if i < bins - 1 else p <= hi)
        if m.sum() > 0:
            e += abs(float(p[m].mean()) - float(y[m].mean())) * int(m.sum()) / N
    return e


def phase_gap(p, y, minute):
    out = {}
    for name, m in [("early(≤60')", minute <= LATE_CUT), ("late (>60')", minute > LATE_CUT)]:
        if m.sum() == 0:
            out[name] = (0, float("nan"), float("nan"), float("nan"))
        else:
            out[name] = (int(m.sum()), float(p[m].mean()), float(y[m].mean()),
                         float(p[m].mean() - y[m].mean()))
    return out


def decile_table(p, y, bins=10):
    edges = np.linspace(0, 1, bins + 1); rows = []
    for i in range(bins):
        lo, hi = edges[i], edges[i + 1]
        m = (p >= lo) & (p < hi if i < bins - 1 else p <= hi)
        n = int(m.sum())
        rows.append((lo, hi, n, float(p[m].mean()) if n else float("nan"),
                     float(y[m].mean()) if n else float("nan")))
    return rows


def _fmt_deciles(rows):
    L = ["     %-12s %8s %11s %11s" % ("bucket prob", "n", "pred_mediu", "rată_reală")]
    for lo, hi, n, pm, rl in rows:
        if n == 0:
            L.append("     %4.1f-%4.1f      %8d %11s %11s" % (lo, hi, n, "-", "-"))
        else:
            L.append("     %4.1f-%4.1f      %8d %11.3f %11.3f" % (lo, hi, n, pm, rl))
    return "\n".join(L)


def variant_block(name, p, y, minute):
    L = []
    L.append("── %s ──" % name)
    L.append("   Brier=%.5f | ECE=%.4f | N=%d" % (brier(p, y), ece(p, y), len(p)))
    pg = phase_gap(p, y, minute)
    for ph, (n, pm, rl, gap) in pg.items():
        if n == 0:
            L.append("   %s: N=0" % ph)
        else:
            L.append("   %s: N=%d pred=%.1f%% real=%.1f%% gap=%+.1f pp" % (
                ph, n, 100*pm, 100*rl, 100*gap))
    return "\n".join(L), pg


def main():
    ap = argparse.ArgumentParser(description="NGP time-decay fix — experiment OFFLINE (read-only).")
    ap.add_argument("--league-id", type=int, default=None, dest="league_id",
                    help="restrânge la o ligă (default: toate)")
    args = ap.parse_args()

    conn = get_conn(); cur = conn.cursor()
    minute, p_raw, y = fetch_ngp(cur, args.league_id)
    cur.close(); conn.close()
    if len(y) < 50:
        print("Prea puține NGP rezolvate (%d). Nimic de testat." % len(y)); sys.exit(2)

    p_a = deboost(p_raw, minute)
    p_b = calibrate_minute_cv(p_raw, y, minute)

    L = []
    L.append("=" * 84)
    L.append(" FIX NGP TIME-DECAY — experiment OFFLINE (READ-ONLY) · N=%d predicții NGP rezolvate" % len(y))
    L.append(" %s" % ("toate ligile" if not args.league_id else "league_id=%d" % args.league_id))
    L.append("=" * 84)

    b_raw, pg_raw = variant_block("NGP BRUT (logat)", p_raw, y, minute)
    b_a, pg_a = variant_block("(a) DE-BOOST principial (ngp+minut)", p_a, y, minute)
    b_b, pg_b = variant_block("(b) RECALIBRARE pe minut (izotonică OOS 5-fold)", p_b, y, minute)
    L += [b_raw, "", b_a, "", b_b, ""]

    # calibrare pe decile, devreme vs târziu (pt fiecare variantă)
    L.append("── CALIBRARE pe decile — TÂRZIU (>60'), unde e ruptura ──")
    late = minute > LATE_CUT
    L.append("  NGP brut:");      L.append(_fmt_deciles(decile_table(p_raw[late], y[late])))
    L.append("  (a) de-boost:");  L.append(_fmt_deciles(decile_table(p_a[late], y[late])))
    L.append("  (b) recalibrat:"); L.append(_fmt_deciles(decile_table(p_b[late], y[late])))

    # ── VERDICT ──
    L.append("")
    L.append("=" * 84)
    L.append(" VERDICT — ținta: gap TÂRZIU → ~0 FĂRĂ să strice DEVREME")
    def g(pg, ph):
        return pg[ph][3]
    early_k, late_k = "early(≤60')", "late (>60')"
    L.append(" %-22s %12s %12s %12s %12s" % ("variantă", "gap_târziu", "gap_devreme", "Brier", "ECE"))
    L.append(" " + "-" * 74)
    for nm, pp, pg in [("NGP brut", p_raw, pg_raw), ("(a) de-boost", p_a, pg_a), ("(b) recalibrat", p_b, pg_b)]:
        L.append(" %-22s %11.1f%% %11.1f%% %12.5f %12.4f" % (
            nm, 100*g(pg, late_k), 100*g(pg, early_k), brier(pp, y), ece(pp, y)))
    # alegere
    def score(pg, pp):
        return abs(g(pg, late_k)), abs(g(pg, early_k)), brier(pp, y)
    cands = {"(a) de-boost": (pg_a, p_a), "(b) recalibrat": (pg_b, p_b)}
    best = min(cands, key=lambda k: (abs(g(cands[k][0], late_k)), brier(cands[k][1], y)))
    bpg, bpp = cands[best]
    raw_late = abs(g(pg_raw, late_k)); new_late = abs(g(bpg, late_k))
    closed = (raw_late - new_late) / raw_late * 100 if raw_late > 1e-9 else float("nan")
    early_dmg = abs(g(bpg, early_k)) - abs(g(pg_raw, early_k))
    L.append("")
    L.append(" CÂȘTIGĂTOR: %s — gap târziu %.1f%% → %.1f%% (închis %.0f%%), Brier %.5f→%.5f, ECE %.4f→%.4f" % (
        best, 100*g(pg_raw, late_k), 100*g(bpg, late_k), closed,
        brier(p_raw, y), brier(bpp, y), ece(p_raw, y), ece(bpp, y)))
    L.append(" efect DEVREME (trebuie ~0): gap %.1f%% → %.1f%% (Δ daună %+.1f pp)" % (
        100*g(pg_raw, early_k), 100*g(bpg, early_k), 100*early_dmg))
    verdict = ("MERITĂ — repară târziul fără să strice devreme" if (new_late < raw_late - 0.01 and
               brier(bpp, y) <= brier(p_raw, y) + 1e-4 and abs(early_dmg) < 0.03)
               else "PARȚIAL / de discutat — vezi compromisul devreme vs târziu")
    L.append(" CONCLUZIE: %s." % verdict)
    L.append(" (Dacă bate, PASUL următor = strat serving-side cu flag + shadow — NU acum, NU în acest script.)")
    L.append("=" * 84)
    L.append(" STRICT READ-ONLY: zero scrieri DB, motorul live NEatins.")

    report = "\n".join(L)
    print(report)
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fix_ngp_timedecay_report.txt")
    try:
        with open(path, "w") as fh:
            fh.write(report + "\n")
        print("\n[raport salvat] %s" % path)
    except Exception as ex:
        print("\n[nu am putut salva: %s]" % ex)


if __name__ == "__main__":
    main()
