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

MEMORIE (2GB) — FIX OOM: NU mai construim cele 1.4M snapshot-uri. Întâi luăm fixture_id DISTINCT
din live_stats (~877 meciuri) și generăm snapshot-uri DOAR pentru ele (generate_half primește
fixture_ids). live_stats: doar coloanele necesare, dtypes minime (int16/int32/float32). float32,
jumătăți separate (r1 → eliberare → r2), del + gc.collect() după fiecare etapă. Estimare nouă:
sub câteva sute de MB (de la 1.6GB → OOM). SAMPLE_CAP rămâne ca plasă, dar NU se mai declanșează.

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
SMOKE_N = 20                   # --smoke: rulează întreg pipeline-ul pe primele N meciuri
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


def _rss_mb():
    import resource
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0   # KB→MB pe Linux


def CK(label):
    R("[ck] %-36s RSS=%.0f MB" % (label, _rss_mb()))


def _group_delta(fids, el, vals, win):
    """Δ vs ~win min în urmă, PER fixture, VECTORIZAT per grup (searchsorted). GARANTAT liniar în
    memorie: out are EXACT forma input-ului (vals). FĂRĂ merge → fără explozie carteziană."""
    n = len(el)
    out = np.full(vals.shape, np.nan, dtype=np.float32)
    if n == 0:
        return out
    uniq, starts = np.unique(fids, return_index=True)   # fids deja sortat → granițe de grup
    bounds = list(starts) + [n]
    for gi in range(len(uniq)):
        a, b = bounds[gi], bounds[gi + 1]
        ge = el[a:b]
        if len(ge) < 2:
            continue
        pos = np.searchsorted(ge, ge - win, side="right") - 1   # ultimul minut <= curent-win
        posc = np.clip(pos, 0, len(ge) - 1)
        gap = ge - ge[posc]
        ok = (pos >= 0) & (gap >= win - 5) & (gap <= win + 8)   # fereastră în jurul lui win
        gv = vals[a:b]
        d = gv - gv[posc]
        d[~ok] = np.nan
        out[a:b] = d
    return out


def load_momentum(conn, fixture_ids=None):
    """Δ ultimele ~10/15 min per (fixture_id, MINUT) din live_stats. INCASABIL:
    1) dedup la UN rând per (fixture, minut) — live_stats scrie la ~10s (multe rânduri/minut),
       statistici CUMULATIVE → max = ultima valoare a minutului. ELIMINĂ produsul cartezian.
    2) Δ per grup prin searchsorted (out == input ca formă). 3) assert pe dimensiuni."""
    statcols = [sd + "_" + s for s in STATS for sd in ["home", "away"]]
    q = "SELECT fixture_id, elapsed, " + ", ".join(statcols) + " FROM live_stats WHERE elapsed IS NOT NULL"
    params = None
    if fixture_ids is not None:
        q += " AND fixture_id = ANY(%(f)s)"
        params = {"f": list(fixture_ids)}
    ls = pd.read_sql(q, conn, params=params)
    CK("live_stats citit (%d rânduri brute)" % len(ls))
    if not len(ls):
        return pd.DataFrame(columns=["fixture_id", "elapsed"] + NEW)
    for c in statcols:
        ls[c] = pd.to_numeric(ls[c], errors="coerce").astype("float32")
    ls["fixture_id"] = pd.to_numeric(ls["fixture_id"], errors="coerce").astype("int64")
    ls["elapsed"] = pd.to_numeric(ls["elapsed"], errors="coerce")
    ls = ls.dropna(subset=["fixture_id", "elapsed"])
    ls["elapsed"] = ls["elapsed"].astype("int64")
    # DEDUP: o singură stare per (fixture, minut) — colapsează rândurile per-secundă.
    ls = ls.groupby(["fixture_id", "elapsed"], as_index=False)[statcols].max()
    ls = ls.sort_values(["fixture_id", "elapsed"]).reset_index(drop=True)
    CK("dedup (fixture,minut) → %d rânduri unice" % len(ls))

    fids = ls["fixture_id"].to_numpy()
    el = ls["elapsed"].to_numpy()
    vals = ls[statcols].to_numpy(dtype=np.float32)
    mom = pd.DataFrame({"fixture_id": ls["fixture_id"].to_numpy(),
                        "elapsed": ls["elapsed"].to_numpy()})
    for w in WINDOWS:
        d = _group_delta(fids, el, vals, w)
        assert d.shape[0] == len(ls), "delta size mismatch (%d != %d) — calcul greșit, abort" % (d.shape[0], len(ls))
        for si, s in enumerate(STATS):           # statcols = [home_s, away_s, ...] → home=2*si, away=2*si+1
            h = d[:, 2 * si]; a = d[:, 2 * si + 1]
            mom["home_" + s + "_mom" + str(w)] = h
            mom["away_" + s + "_mom" + str(w)] = a
            mom["diff_" + s + "_mom" + str(w)] = h - a
    assert len(mom) == len(ls), "momentum size != input (%d != %d)" % (len(mom), len(ls))
    CK("momentum gata (%d rânduri × %d feature)" % (len(mom), len(NEW)))
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
    CK("%s: X=%s" % (name, str(X.shape)))
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

    # [FULL SET] eliminat: după filtrarea la sursă pe meciurile live_stats, NU mai construim
    # 1.4M snapshot-uri (era ieftin doar înainte) și oricum era diluat de NaN→median. Verdictul
    # se dă pe SUBSETUL ACOPERIT (snapshot-uri cu momentum real) — apples-to-apples, n raportat.
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
    smoke = ("--smoke" in sys.argv)
    R("EXPERIMENT MOMENTUM LIVE (#3a)%s — %s" % (" [SMOKE]" if smoke else "", pd.Timestamp.now()))
    tl.assert_no_odds(tl.FEATURES + NEW)   # ZIDUL ANTI-COTE pe setul extins
    R("Zidul anti-cote: OK · feature-uri momentum noi: %d" % len(NEW))
    CK("start")

    conn = tl.get_conn()
    # MEMORY-LEAN: snapshot-urile se generează DOAR pentru meciurile acoperite de live_stats.
    fids = pd.read_sql("SELECT DISTINCT fixture_id FROM live_stats WHERE elapsed IS NOT NULL",
                       conn)["fixture_id"].dropna().astype(int).tolist()
    if smoke:
        fids = sorted(fids)[:SMOKE_N]
        R("SMOKE: restrâns la primele %d meciuri." % len(fids))
    R("live_stats: %d meciuri → generate_half + momentum DOAR pe ele." % len(fids))
    mom = load_momentum(conn, fixture_ids=fids)
    R("momentum: %d rânduri (fixture×minut) cu Δ10/Δ15." % len(mom))
    CK("după load_momentum")
    fmap = tl.load_feature_map(conn)
    fmap_proc, _med, default_ff = tl.process_feature_map(fmap)
    del fmap; gc.collect()
    CK("după feature_map")
    cov_counts = {"total": 0, "ml_features": 0, "elo_history": 0, "standings": 0, "referee": 0}

    res = {}
    Xr1, fidr1, labr1, nr1, _mk1 = tl.generate_half(conn, "r1", fmap_proc, default_ff, cov_counts, fixture_ids=fids)
    CK("generate_half r1 (X=%s)" % str(Xr1.shape))
    res["r1"] = eval_half("REPRIZA 1", Xr1, fidr1, labr1, BIN_R1, MULTI["r1"], mom)
    del Xr1, fidr1, labr1; gc.collect(); CK("după R1")
    Xr2, fidr2, labr2, nr2, _mk2 = tl.generate_half(conn, "r2", fmap_proc, default_ff, cov_counts, fixture_ids=fids)
    CK("generate_half r2 (X=%s)" % str(Xr2.shape))
    res["r2"] = eval_half("REPRIZA 2 / FINAL", Xr2, fidr2, labr2, BIN_R2, MULTI["r2"], mom)
    del Xr2, fidr2, labr2; gc.collect(); CK("după R2")
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
