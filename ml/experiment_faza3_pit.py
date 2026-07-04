"""
ml/experiment_faza3_pit.py — FAZA 3: verdict Brier A/B — aduce score7 PIT valoare?
READ-ONLY (SELECT only pe DB; scrie DOAR ml/experiment_faza3_pit_report.txt + stdout).
NU atinge producția (train_model/train_live/crontab/imutabile).

Reutilizează pipeline-ul de antrenare existent:
  train_model as tm  → tm.QUERY, tm.FEATURES_PREMATCH, tm.MARKETS, tm.get_conn, tm.assert_no_odds
  calibrate  as cal  → cal.prep_prematch(df) (derivă features + labels, ca în producție)
Model IDENTIC producției: HistGradientBoostingClassifier(max_iter=200, max_depth=4,
learning_rate=0.1, random_state=42). Testăm FEATURES, nu tuning.

Split TEMPORAL strict (AMBELE):
  S1: train 2022-2024 → test 2025 complet.
  S2: train 2022-2025 → test 2026-to-date (doar meciuri încheiate — tm.QUERY filtrează
      result_winner NOT NULL, deci testul are doar rezultate reale).
Subset COMUN pe pit_score7 IS NOT NULL (A și B pe ACELEAȘI rânduri → comparație curată).

Modele:
  A (baseline) = tm.FEATURES_PREMATCH (features actuale, FĂRĂ pit_*).
  B           = A + pit_score7 + pit_score6 + pit_confidence + pit_players_n.
  C (extra, onest) = (A − score7/score6/confidence de PRODUCȚIE) + pit_*  →  scenariul de
      integrare reală (înlocuiește score7/6/confidence leaky-pe-istoric cu versiunile PIT).

Rulare:  cd /root/scannerv2 && python3 -u ml/experiment_faza3_pit.py
"""
import os
import sys

ML_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ML_DIR)

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import brier_score_loss, log_loss

import train_model as tm
import calibrate as cal

REPORT = os.path.join(ML_DIR, "experiment_faza3_pit_report.txt")
HP = dict(max_iter=200, max_depth=4, learning_rate=0.1, random_state=42)  # identic producției
TOL = 0.001  # prag verdict IMBUNATATIRE/DEGRADARE

PIT_FEATS = ["pit_score7", "pit_score6", "pit_confidence", "pit_players_n"]
PROD_S7   = ["score7", "score6", "confidence"]   # versiunile de producție (leaky pe istoric)
MARKETS_AB = [
    ("over15",   "y_over15",   "Over 1.5"),
    ("over25",   "y_over25",   "Over 2.5"),
    ("gg",       "y_btts",     "GG/BTTS"),
    ("1x2_home", "y_home_win", "1 (Home win)"),
]

_rep = []
def R(s=""):
    print(s); _rep.append(s)


def load():
    conn = tm.get_conn()
    df = pd.read_sql(tm.QUERY, conn)
    pit = pd.read_sql(
        "SELECT fixture_id, pit_score7, pit_score6, pit_confidence, pit_players_n FROM ml_features", conn)
    conn.close()
    df = cal.prep_prematch(df)
    df = df.merge(pit, on="fixture_id", how="left")
    # temporal weight ca în producție (train_model.main)
    df["days_old"] = (pd.Timestamp.now(tz="UTC") - pd.to_datetime(df["created_at"], utc=True, errors="coerce")).dt.days
    df["sample_weight"] = np.exp(-0.001 * df["days_old"].fillna(0))
    df["year"] = pd.to_datetime(df["match_date"], utc=True, errors="coerce").dt.year
    for c in PIT_FEATS:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def prep_X(sub, mask, feats):
    X = sub.loc[mask, feats].apply(pd.to_numeric, errors="coerce")
    med = X.median()
    return X.fillna(med).fillna(0)


def eval_model(sub, tr_mask, te_mask, feats, ycol):
    """Antrenează HistGB pe (tr_mask) și evaluează Brier+logloss pe (te_mask).
    Restrânge la rândurile cu label non-null. Întoarce dict sau None dacă insuficient."""
    yfull = pd.to_numeric(sub[ycol], errors="coerce")
    tr = tr_mask & yfull.notna()
    te = te_mask & yfull.notna()
    if tr.sum() < 100 or te.sum() < 20:
        return None
    ytr = yfull[tr].astype(int); yte = yfull[te].astype(int)
    if ytr.nunique() < 2 or yte.nunique() < 2:
        return None
    Xtr = prep_X(sub, tr, feats); Xte = prep_X(sub, te, feats)
    wtr = sub.loc[tr, "sample_weight"].values
    gb = HistGradientBoostingClassifier(**HP)
    gb.fit(Xtr, ytr, sample_weight=wtr)
    p = gb.predict_proba(Xte)[:, 1]
    return dict(n=int(te.sum()), brier=float(brier_score_loss(yte, p)),
                logloss=float(log_loss(yte, p, labels=[0, 1])))


def verdict(delta):
    if delta is None:
        return "n/a"
    if delta < -TOL:
        return "IMBUNATATIRE"
    if delta > TOL:
        return "DEGRADARE"
    return "NEUTRU"


def run_split(sub, name, train_years, test_year):
    R("\n" + "=" * 92)
    R(f"SPLIT {name}: train {train_years} → test {test_year}")
    R("=" * 92)
    tr_mask = sub["year"].isin(train_years)
    te_mask = sub["year"] == test_year
    R(f"  rânduri subset (pit_score7 NOT NULL): train={int(tr_mask.sum())} test={int(te_mask.sum())}")
    R("%-14s %7s | %9s %9s | %9s %9s %-13s | %9s %9s %-13s" %
      ("piata", "n_test", "brierA", "llA", "brierB", "dB", "verdict_B", "brierC", "dC", "verdict_C"))
    R("-" * 92)
    out = {}
    baseA = tm.FEATURES_PREMATCH
    baseB = tm.FEATURES_PREMATCH + PIT_FEATS
    baseC = [f for f in tm.FEATURES_PREMATCH if f not in PROD_S7] + PIT_FEATS
    for key, ycol, desc in MARKETS_AB:
        rA = eval_model(sub, tr_mask, te_mask, baseA, ycol)
        rB = eval_model(sub, tr_mask, te_mask, baseB, ycol)
        rC = eval_model(sub, tr_mask, te_mask, baseC, ycol)
        if rA is None or rB is None:
            R("%-14s   (date insuficiente — sărit)" % desc); continue
        dB = rB["brier"] - rA["brier"]
        dC = (rC["brier"] - rA["brier"]) if rC else None
        out[key] = dict(dB=dB, dC=dC)
        R("%-14s %7d | %9.5f %9.5f | %9.5f %+9.5f %-13s | %9s %9s %-13s" % (
            desc, rA["n"], rA["brier"], rA["logloss"], rB["brier"], dB, verdict(dB),
            ("%9.5f" % rC["brier"]) if rC else "n/a",
            ("%+9.5f" % dC) if dC is not None else "n/a", verdict(dC)))
    return out


def main():
    R("EXPERIMENT FAZA 3 — score7 PIT: aduce valoare? (%s)" % pd.Timestamp.now())
    tm.assert_no_odds(tm.FEATURES_PREMATCH + PIT_FEATS)   # ZIDUL ANTI-COTE
    R("Zidul anti-cote: OK")
    R("Model: HistGradientBoosting %s (identic producției) · TOL verdict ±%.4f" % (HP, TOL))

    df = load()
    R("Date brute: %d predicții rezolvate" % len(df))
    sub = df[df["pit_score7"].notna()].reset_index(drop=True)
    R("Subset pit_score7 NOT NULL: %d (%.1f%%)" % (len(sub), 100.0 * len(sub) / max(len(df), 1)))
    for y in sorted(set(int(v) for v in sub["year"].dropna().unique())):
        R("  an %d: %d rânduri" % (y, int((sub["year"] == y).sum())))

    s1 = run_split(sub, "S1", [2022, 2023, 2024], 2025)
    s2 = run_split(sub, "S2", [2022, 2023, 2024, 2025], 2026)

    # ── VERDICT: concordanță S1 vs S2 pe delta B−A ──
    R("\n" + "=" * 92)
    R("VERDICT — concordanță S1 vs S2 (delta B−A; negativ = B mai bun)")
    R("=" * 92)
    R("%-14s %12s %12s %14s" % ("piata", "dB_S1", "dB_S2", "concordanta"))
    both_better = 0; keys = 0
    for key, ycol, desc in MARKETS_AB:
        a = s1.get(key, {}).get("dB"); b = s2.get(key, {}).get("dB")
        if a is None or b is None:
            R("%-14s %12s %12s %14s" % (desc, "n/a", "n/a", "-")); continue
        keys += 1
        same = (a < -TOL and b < -TOL)
        if same: both_better += 1
        conc = "AMBELE BUN" if same else ("AMBELE RĂU" if (a > TOL and b > TOL) else "MIXT/NEUTRU")
        R("%-14s %+12.5f %+12.5f %14s" % (desc, a, b, conc))

    R("")
    if keys and both_better >= max(1, keys // 2) and both_better == keys:
        R("➜ score7 PIT ADUCE VALOARE pe AMBELE split-uri → RECOMAND integrarea pit_* în train_model.py")
        R("  (o schimbare pe rând, măsurată). Vezi și coloana C: dacă C≈B, se pot ÎNLOCUI score7/6/confidence")
        R("  de producție (leaky pe istoric) cu versiunile PIT.")
    elif both_better > 0:
        R("➜ MIXT: score7 PIT ajută DOAR pe unele piețe/split-uri. Integrare SELECTIVĂ (doar piețele cu")
        R("  IMBUNATATIRE concordantă pe S1 ȘI S2); restul — închide subiectul.")
    else:
        R("➜ score7 PIT NU aduce valoare (concordant pe ambele split-uri) → ÎNCHIDE subiectul score7-în-ML.")
        R("  Confirmă verdictul preliminar (PR #9): semnalul e deja captat de features existente.")
    R("\nNB: READ-ONLY — producția neatinsă. Baseline A conține score7/6/confidence de PRODUCȚIE")
    R("(pe istoric calculate cu ORDER BY fixture_id DESC = ușor leaky); coloana C e testul de integrare curat.")

    with open(REPORT, "w") as f:
        f.write("\n".join(_rep) + "\n")
    R("\n✅ Raport: %s" % REPORT)


if __name__ == "__main__":
    main()
