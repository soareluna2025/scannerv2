"""
ml/experiment_momentum.py — EXPERIMENT ML #3a: MOMENTUM LIVE (presiunea ultimelor 10-15 min).
READ-ONLY. NU atinge producția (train_live_v2/crontab). Țintă: GOLURI (R1/R2) + URMĂTORUL GOL.

Ipoteză: presiunea RECENTĂ (Δ ultimele ~10/15 min la șuturi/SOT/atacuri periculoase/cornere/
posesie) e semnal puternic pentru următorul gol și golurile reprizei curente.

SURSA momentum-ului: tabela `live_stats` (snapshot-uri succesive per meci, cu exact aceste
coloane + elapsed). ⚠ ACOPERIRE LIMITATĂ: live_stats există DOAR pentru meciurile observate
LIVE de scanner (recente), pe când setul de antrenare e 2023+ → momentum-ul acoperă o
fracțiune. Raportăm acoperirea ȘI evaluăm separat pe SUBSETUL acoperit (acolo unde momentum
chiar există) — verdictul real e pe subset.

Reutilizare (import, nu copy-paste): train_live_v2.generate_half (snapshot-uri + features live
existente + labels), FEATURES, assert_no_odds, _multiclass_brier. Momentum se ATAȘEAZĂ la
fiecare snapshot prin (fixture_id, minut) — minutul recuperat din elapsed_norm (=min(1,elapsed/90)).

MEMORIE (2GB, ~1.4M snapshot-uri R2): float32, procesare pe jumătăți (r1 apoi r2, cu eliberare),
plafon SAMPLE_CAP cu eșantionare stratificată TEMPORAL (stride) dacă o jumătate depășește capul.

Rulare:  cd /root/scannerv2 && python3 -u ml/experiment_momentum.py
"""
import os
import sys
import gc

ML_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ML_DIR)

import numpy as np
import pandas as pd
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss

import train_live_v2 as tl

REPORT = os.path.join(ML_DIR, "experiment_momentum_report.txt")
SPLIT_FRAC = 0.8
SAMPLE_CAP = 700000            # peste atât pe o jumătate → eșantionare temporală (stride)
WORSEN_TOL = 0.0005
STATS = ["sot", "shots", "da", "corners", "possession"]
WINDOWS = [10, 15]
NEW = [sd + "_" + s + "_mom" + str(w) for w in WINDOWS for s in STATS for sd in ["home", "away", "diff"]]

# Piețe de GOLURI (binare) + URMĂTORUL GOL (multiclass), per jumătate.
BIN_R1 = ["goals_r1_over05", "goals_r1_over15", "goals_r1_over25"]
BIN_R2 = ["goals_total_over15", "goals_total_over25", "goals_r2_over05", "goals_r2_over15"]
MULTI = {"r1": "next_goal_r1", "r2": "next_goal_r2"}

_rep = []
def R(s=""):
    print(s); _rep.append(s)


def load_momentum(conn):
    """Δ ultimele ~10/15 min per (fixture_id, minut) din live_stats (self merge_asof)."""
    cols = ", ".join(["home_" + s + ", away_" + s for s in STATS])
    ls = pd.read_sql("SELECT fixture_id, elapsed, " + cols + " FROM live_stats WHERE elapsed IS NOT NULL", conn)
    if not len(ls):
        return pd.DataFrame(columns=["fixture_id", "elapsed"] + NEW)
    statcols = [sd + "_" + s for s in STATS for sd in ["home", "away"]]
    for c in statcols:
        ls[c] = pd.to_numeric(ls[c], errors="coerce").astype("float32")
    ls["elapsed"] = pd.to_numeric(ls["elapsed"], errors="coerce")
    ls = ls.dropna(subset=["elapsed"]); ls["elapsed"] = ls["elapsed"].astype(int)
    ls = ls.sort_values(["fixture_id", "elapsed"])

    def delta(win):
        base = ls[["fixture_id", "elapsed"] + statcols].sort_values("elapsed")
        past = base.copy(); past["elapsed"] = past["elapsed"] + win
        past = past.sort_values("elapsed")
        m = pd.merge_asof(base, past, by="fixture_id", on="elapsed",
                          direction="backward", tolerance=win // 2 + 3, suffixes=("", "_p"))
        d = m[["fixture_id", "elapsed"]].copy()
        for s in STATS:
            h = m["home_" + s] - m["home_" + s + "_p"]
            a = m["away_" + s] - m["away_" + s + "_p"]
            d["home_" + s + "_mom" + str(win)] = h
            d["away_" + s + "_mom" + str(win)] = a
            d["diff_" + s + "_mom" + str(win)] = h - a
        return d

    mom = delta(WINDOWS[0])
    for w in WINDOWS[1:]:
        mom = mom.merge(delta(w), on=["fixture_id", "elapsed"], how="outer")
    return mom


def attach_momentum(X, fid, mom):
    """Atașează cele 30 feature-uri momentum la fiecare snapshot prin (fixture_id, minut≈)."""
    en = tl.BASE_FEATURES.index("elapsed_norm")
    elapsed = np.rint(X[:, en].astype(np.float64) * 90.0).astype(int)
    tr = pd.DataFrame({"fixture_id": fid.astype(int), "elapsed": elapsed, "_i": np.arange(len(fid))})
    if not len(mom):
        return np.full((len(fid), len(NEW)), np.nan, dtype=np.float32), np.zeros(len(fid), bool)
    tr = tr.sort_values("elapsed")
    ms = mom.sort_values("elapsed")
    j = pd.merge_asof(tr, ms, by="fixture_id", on="elapsed", direction="nearest", tolerance=3)
    j = j.sort_values("_i")
    M = j[NEW].to_numpy(dtype=np.float32)
    covered = ~np.isnan(M[:, 0])
    return M, covered


def _fill_median(M):
    M = M.copy()
    for c in range(M.shape[1]):
        col = M[:, c]; ok = ~np.isnan(col)
        med = np.median(col[ok]) if ok.any() else 0.0
        col[~ok] = med; M[:, c] = col
    return M


def _brier_bin(Xtr, ytr, Xte, yte):
    sc = StandardScaler().fit(Xtr)
    lr = LogisticRegression(max_iter=1000).fit(sc.transform(Xtr), ytr)
    p = lr.predict_proba(sc.transform(Xte))[:, 1]
    return float(brier_score_loss(yte, p)), lr, sc


def _eval_multi(Xtr, ytr, Xte, yte):
    sc = StandardScaler().fit(Xtr)
    lr = LogisticRegression(max_iter=1000, multi_class="multinomial").fit(sc.transform(Xtr), ytr)
    proba = lr.predict_proba(sc.transform(Xte))
    classes = list(lr.classes_)
    ll = float(log_loss(yte, proba, labels=classes))
    mb = float(tl._multiclass_brier(yte, proba, classes))
    return ll, mb


def split_idx(n):
    return int(n * SPLIT_FRAC)


def maybe_sample(X, fid, labels):
    n = X.shape[0]
    if n <= SAMPLE_CAP:
        return X, fid, labels, 1
    k = int(np.ceil(n / SAMPLE_CAP))     # stride temporal (X e cronologic) → eșantion stratificat
    sel = np.arange(0, n, k)
    labels2 = {m: labels[m][sel] for m in labels}
    return X[sel], fid[sel], labels2, k


def eval_half(name, X, fid, labels, markets_bin, market_multi, mom):
    R("\n══════ %s ══════" % name)
    X, fid, labels, stride = maybe_sample(X, fid, labels)
    if stride > 1:
        R("Eșantionare TEMPORALĂ stride=%d → %d snapshot-uri (memorie)." % (stride, X.shape[0]))
    M, covered = attach_momentum(X, fid, mom)
    cov = int(covered.sum()); n = X.shape[0]
    R("Acoperire momentum: %d/%d (%.2f%%)" % (cov, n, 100.0 * cov / max(n, 1)))
    Mf = _fill_median(M)
    Xexp = np.hstack([X, Mf]).astype(np.float32)
    i = split_idx(n)
    cov_idx = np.where(covered)[0]

    def run_bin(mkey, use_cov):
        y = np.asarray(labels[mkey], dtype=int)
        if use_cov:
            if len(cov_idx) < 400: return None
            ic = int(len(cov_idx) * SPLIT_FRAC)
            tr, te = cov_idx[:ic], cov_idx[ic:]
        else:
            tr, te = np.arange(i), np.arange(i, n)
        if len(np.unique(y[tr])) < 2 or len(np.unique(y[te])) < 2: return None
        bb, _, _ = _brier_bin(X[tr], y[tr], X[te], y[te])
        be, _, _ = _brier_bin(Xexp[tr], y[tr], Xexp[te], y[te])
        return bb, be, len(te)

    R("\n[FULL SET] (momentum NaN→median pe necacoperite)")
    R("%-20s %9s %9s %9s" % ("piață", "Brier_b", "Brier_e", "Δ(b-e)"))
    full = {}
    for mk in markets_bin:
        r = run_bin(mk, False)
        if r: full[mk] = r; R("%-20s %9.5f %9.5f %+9.5f" % (mk, r[0], r[1], r[0] - r[1]))

    R("\n[SUBSET ACOPERIT] (doar snapshot-uri cu momentum real — verdictul ADEVĂRAT)")
    R("%-20s %9s %9s %9s   n" % ("piață", "Brier_b", "Brier_e", "Δ(b-e)"))
    imp = 0; bad = 0; valid = 0
    for mk in markets_bin:
        r = run_bin(mk, True)
        if not r: R("%-20s  (subset prea mic/o clasă — sărit)" % mk); continue
        valid += 1; d = r[0] - r[1]
        if d > 0: imp += 1
        if d < -WORSEN_TOL: bad += 1
        R("%-20s %9.5f %9.5f %+9.5f   %d" % (mk, r[0], r[1], d, r[2]))

    # URMĂTORUL GOL (multiclass) — piață PRIORITARĂ
    R("\n[URMĂTORUL GOL — %s] (log loss + Brier multiclass, subset acoperit)" % market_multi)
    ymul = np.asarray(labels[market_multi], dtype=int)
    if len(cov_idx) >= 600 and len(np.unique(ymul[cov_idx])) >= 2:
        ic = int(len(cov_idx) * SPLIT_FRAC)
        tr, te = cov_idx[:ic], cov_idx[ic:]
        if len(np.unique(ymul[tr])) >= 2 and len(np.unique(ymul[te])) >= 2:
            llb, mbb = _eval_multi(X[tr], ymul[tr], X[te], ymul[te])
            lle, mbe = _eval_multi(Xexp[tr], ymul[tr], Xexp[te], ymul[te])
            R("  log loss: %.5f → %.5f  (Δ %+.5f)" % (llb, lle, llb - lle))
            R("  Brier mc: %.5f → %.5f  (Δ %+.5f)  n=%d" % (mbb, mbe, mbb - mbe, len(te)))
            ng_improved = (lle < llb)
        else:
            R("  (o singură clasă în split — sărit)"); ng_improved = None
    else:
        R("  (subset acoperit prea mic — sărit)"); ng_improved = None

    del X, Xexp, Mf, M
    gc.collect()
    return {"valid": valid, "improved": imp, "bad": bad, "ng_improved": ng_improved, "cov": cov, "n": n}


def main():
    R("EXPERIMENT MOMENTUM LIVE (#3a) — %s" % pd.Timestamp.now())
    tl.assert_no_odds(tl.FEATURES + NEW)   # ZIDUL ANTI-COTE pe setul extins
    R("Zidul anti-cote: OK · feature-uri momentum noi: %d\n" % len(NEW))

    conn = tl.get_conn()
    mom = load_momentum(conn)
    R("live_stats momentum: %d rânduri (fixture×minut) cu Δ10/Δ15." % len(mom))
    fmap = tl.load_feature_map(conn)
    fmap_proc, _med, default_ff = tl.process_feature_map(fmap)
    cov_counts = {"total": 0, "ml_features": 0, "elo_history": 0, "standings": 0, "referee": 0}

    res = {}
    Xr1, fidr1, labr1, nr1, _mk1 = tl.generate_half(conn, "r1", fmap_proc, default_ff, cov_counts)
    res["r1"] = eval_half("REPRIZA 1", Xr1, fidr1, labr1, BIN_R1, MULTI["r1"], mom)
    del Xr1, fidr1, labr1; gc.collect()
    Xr2, fidr2, labr2, nr2, _mk2 = tl.generate_half(conn, "r2", fmap_proc, default_ff, cov_counts)
    res["r2"] = eval_half("REPRIZA 2 / FINAL", Xr2, fidr2, labr2, BIN_R2, MULTI["r2"], mom)
    del Xr2, fidr2, labr2; gc.collect()
    conn.close()

    # VERDICT
    R("\n══════ VERDICT GLOBAL ══════")
    tv = sum(res[h]["valid"] for h in res); ti = sum(res[h]["improved"] for h in res); tb = sum(res[h]["bad"] for h in res)
    R("Piețe goluri (subset acoperit): %d · îmbunătățite: %d · înrăutățite >%.4f: %d" % (tv, ti, WORSEN_TOL, tb))
    R("URMĂTORUL GOL — prioritar: R1=%s · R2=%s" % (
        {True: "✅ mai bun", False: "❌ nu", None: "n/a"}[res["r1"]["ng_improved"]],
        {True: "✅ mai bun", False: "❌ nu", None: "n/a"}[res["r2"]["ng_improved"]]))
    adopt = (tv > 0 and ti > tv / 2 and tb == 0)
    if adopt:
        R("➜ ADOPȚIE RECOMANDATĂ (pe meciurile cu live_stats): momentum-ul ajută unde există.")
        R("  Limitare: acoperire parțială → pasul real = colectare live_stats sistematică + materializare")
        R("  point-in-time în snapshot-uri, apoi adăugare în train_live_v2 + reantrenare măsurată.")
    else:
        R("➜ NU adopta acum: criteriul (majoritate îmbunătățită + 0 înrăutățiri) NU e îndeplinit pe")
        R("  subsetul acoperit, SAU acoperirea e prea mică pentru un verdict robust.")
    R("\nNB: experiment READ-ONLY — producția (train_live_v2/crontab) NEATINSĂ.")

    with open(REPORT, "w") as f:
        f.write("\n".join(_rep) + "\n")
    R("\n✅ Raport: %s" % REPORT)


if __name__ == "__main__":
    main()
