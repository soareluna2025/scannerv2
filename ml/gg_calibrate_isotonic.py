"""
ml/gg_calibrate_isotonic.py — RECALIBRARE GG (BTTS): isotonic peste ggProb SERVIT.
READ-ONLY pe DB (doar SELECT). Scrie ml/gg_calibration.json + ml/gg_calibration_report.txt.
NU atinge formula Poisson/λ/Maher (imutabile) — calibrarea e un STRAT DEASUPRA.

Sursă: predictions.gg_prob (= EXACT valoarea servită/logată de enrich.js, 1 rând/fixture,
result_gg curat din update-results). Fit isotonic pe date <= 2025-12-31, evaluare pe 2026-to-date.

SELF-GUARD (STOP automat): dacă Brier(TEST) NU se îmbunătățește sau volumul e prea mic →
validated=false → enrich.js NU aplică (rămâne identitate chiar și cu flag ON). Astfel, dacă
diagnosticul/relația nu e calibrabilă global, calibrarea nu se activează niciodată.

Integrare cron: apelat în slotul EXISTENT 06:50 (după calibrate.py), nu cron nou.
Rulare manuală: cd /root/scannerv2 && python3 -u ml/gg_calibrate_isotonic.py
"""
import os
import sys
import json
from datetime import datetime, timezone

ML_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ML_DIR)

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import brier_score_loss

import train_model as tm

OUT = os.path.join(ML_DIR, "gg_calibration.json")
REPORT = os.path.join(ML_DIR, "gg_calibration_report.txt")
CUTOFF = "2026-01-01"          # fit: match_date < CUTOFF ; test: >= CUTOFF
MIN_FIT, MIN_TEST = 500, 200   # sub aceste volume → identitate (nevalidată)

QUERY = """
SELECT gg_prob, result_gg, match_date
FROM predictions
WHERE result_gg IS NOT NULL AND gg_prob IS NOT NULL AND match_date IS NOT NULL
ORDER BY match_date
"""

_rep = []
def R(s=""):
    print(s); _rep.append(s)


def curve(p, y):
    """Curbă de calibrare pe benzi de 5% (pred_avg, actual_rate, n)."""
    d = pd.DataFrame({"p": p * 100.0, "y": y})
    d["band"] = (np.floor(d["p"] / 5) * 5).astype(int)
    out = []
    for b, g in d.groupby("band"):
        out.append((int(b), len(g), round(g["p"].mean(), 1), round(100.0 * g["y"].mean(), 1)))
    return out


def write_export(export):
    with open(OUT, "w") as f:
        json.dump(export, f, indent=2)


def main():
    R("GG RECALIBRARE isotonic (%s)" % datetime.now(timezone.utc).isoformat())
    conn = tm.get_conn()
    df = pd.read_sql(QUERY, conn)
    conn.close()
    df["match_date"] = pd.to_datetime(df["match_date"], utc=True, errors="coerce")
    df["p"] = pd.to_numeric(df["gg_prob"], errors="coerce") / 100.0
    df["y"] = (pd.to_numeric(df["result_gg"], errors="coerce") > 0.5).astype(int)
    df = df.dropna(subset=["p", "match_date"])
    cutoff = pd.Timestamp(CUTOFF, tz="UTC")
    tr = df[df["match_date"] < cutoff]
    te = df[df["match_date"] >= cutoff]
    R("Date: total %d | fit(<%s) %d | test(>=%s) %d" % (len(df), CUTOFF, len(tr), CUTOFF, len(te)))

    fit_at = datetime.now(timezone.utc).isoformat()
    if len(tr) < MIN_FIT or len(te) < MIN_TEST:
        R("⚠ Volum insuficient (fit<%d sau test<%d) → IDENTITATE, validated=false." % (MIN_FIT, MIN_TEST))
        grid = np.linspace(0, 1, 101)
        write_export({"x": [round(float(v), 4) for v in grid], "y": [round(float(v), 4) for v in grid],
                      "validated": False, "reason": "volum insuficient",
                      "n_fit": int(len(tr)), "n_test": int(len(te)), "fit_at": fit_at})
        with open(REPORT, "w") as f: f.write("\n".join(_rep) + "\n")
        return

    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
    iso.fit(tr["p"].values, tr["y"].values)

    p_before = np.clip(te["p"].values, 1e-3, 1 - 1e-3)
    p_after = np.clip(iso.predict(te["p"].values), 1e-3, 1 - 1e-3)
    b_before = float(brier_score_loss(te["y"].values, p_before))
    b_after = float(brier_score_loss(te["y"].values, p_after))
    delta = b_after - b_before
    validated = bool(b_after < b_before)   # doar dacă îmbunătățește pe TEST

    R("\n-- BRIER pe TEST 2026 --")
    R("  înainte (raw ggProb): %.5f" % b_before)
    R("  după (isotonic):      %.5f" % b_after)
    R("  delta: %+.5f  %s" % (delta, "→ ÎMBUNĂTĂȚIRE (validat)" if validated else "→ NU îmbunătățește (NEvalidat)"))

    R("\n-- CURBA pe TEST: band | n | pred_avg | actual_rate --")
    R("  ÎNAINTE (raw):")
    for b, n, pa, ar in curve(te["p"].values, te["y"].values):
        R("    %3d  n=%-6d pred=%-6.1f actual=%.1f" % (b, n, pa, ar))
    R("  DUPĂ (isotonic):")
    for b, n, pa, ar in curve(iso.predict(te["p"].values), te["y"].values):
        R("    %3d  n=%-6d pred=%-6.1f actual=%.1f" % (b, n, pa, ar))

    grid = np.linspace(0, 1, 101)
    ycal = np.clip(iso.predict(grid), 0.0, 1.0)
    write_export({
        "x": [round(float(v), 4) for v in grid],
        "y": [round(float(v), 4) for v in ycal],
        "validated": validated, "brier_before": b_before, "brier_after": b_after,
        "delta": delta, "n_fit": int(len(tr)), "n_test": int(len(te)),
        "cutoff": CUTOFF, "fit_at": fit_at,
    })
    R("\n→ %s (validated=%s)" % (OUT, validated))
    if not validated:
        R("STOP: calibrarea NU se activează (validated=false). enrich.js rămâne pe identitate")
        R("chiar și cu GG_CALIBRATION=ON. Rulează diagnosticul (scripts/gg-calib-diagnostic.sql) —")
        R("dacă ruptura e per-ligă, nu forța calibrare globală.")
    with open(REPORT, "w") as f:
        f.write("\n".join(_rep) + "\n")
    R("✅ Raport: %s" % REPORT)


if __name__ == "__main__":
    main()
