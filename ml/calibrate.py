"""
ml/calibrate.py — STRAT DE CALIBRARE per piață (isotonic, STRICT out-of-sample temporal).
NU atinge modelele. Învață o mapare monotonă prob_model→prob_reală pe o fereastră de
VALIDARE (date pe care modelul NU le-a văzut la antrenare) și o evaluează pe o fereastră
ULTERIOARĂ (time-forward) → zero leakage. Export piecewise (breakpoints) aplicabil în Node
prin interpolare liniară monotonă + clamp [0.01,0.99].

Rulare (pe VPS, după antrenări):
    cd /root/scannerv2 && python3 -u ml/calibrate.py

Output:
    ml/calibration_export.json       (pre-meci, 63 piețe)
    ml/calibration_live_export.json  (live, 31 piețe)
    ml/calibration_report.txt        (Brier înainte/după + reliability per piață)

Metodă, per piață binară:
  • Split TEMPORAL 60/20/20 (cronologic): TRAIN (model) | CALIB (isotonic) | TEST (eval).
  • Fit StandardScaler+LogisticRegression pe TRAIN (aceeași arhitectură ca antrenarea).
  • Isotonic pe predicțiile din CALIB (OOS pt model). Evaluare pe TEST (OOS pt isotonic).
  • <500 rezultate în CALIB → IDENTITATE (necalibrată). Dacă Brier(TEST) se înrăutățește
    după calibrare → piața rămâne IDENTITATE (raportat explicit).
  • Multiclass (next_goal_r1/r2, result_r1/result_final) → calibrare one-vs-rest: isotonic per
    clasă pe CALIB + renormalizare la sumă 1; criteriu = log loss(TEST). 1X2 pre-meci rămâne BINAR
    (home_win/draw/away_win calibrate individual) — NU se atinge.
"""
import os
import sys
import json
import numpy as np

ML_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ML_DIR)

import pandas as pd
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import brier_score_loss, log_loss

import train_model as tm            # QUERY, FEATURES_PREMATCH/HT, MARKETS, get_conn
import train_live_v2 as tl          # get_conn, load_feature_map, process_feature_map, generate_half, MARKETS

MIN_CAL = 500           # sub atât în fereastra de CALIBRARE → identitate
MIN_TOTAL = 1500        # sub atât total → identitate (nu putem face 60/20/20 fiabil)
MIN_CLASS = 500         # multiclass: minim per CLASĂ minoritară în fereastra CALIB
BUCKETS = [(0.4, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 0.9)]
# Cod întreg → etichetă clasă (TREBUIE să fie identic cu serving-ul: lrProbMulti cheie pe string).
NG2STR  = {0: "home", 1: "away", 2: "none"}   # next_goal_* (NG_CODE din train_live_v2)
RES2STR = {0: "1",    1: "X",    2: "2"}       # result_*    (RESULT_CODE din train_live_v2)
PRE_OUT  = os.path.join(ML_DIR, "calibration_export.json")
LIVE_OUT = os.path.join(ML_DIR, "calibration_live_export.json")
REPORT   = os.path.join(ML_DIR, "calibration_report.txt")

_report_lines = []
def R(s=""):
    print(s)
    _report_lines.append(s)


# ── Derivări + labels PRE-MECI (COPIE fidelă din train_model.main — ANTI-DRIFT) ──
def prep_prematch(df):
    df["days_old"] = (pd.Timestamp.now(tz="UTC") - pd.to_datetime(df["created_at"], utc=True)).dt.days
    df["sample_weight"] = np.exp(-0.001 * df["days_old"])
    for c in ["home_goals", "away_goals", "home_ht_final", "away_ht_final",
              "lambda_home", "lambda_away", "home_elo", "away_elo",
              "shots_home", "shots_away", "shots_on_target_home", "shots_on_target_away",
              "corners_home", "corners_away", "possession_home", "possession_away",
              "yc_home", "yc_away"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    _new_feats = [
        "home_sot_avg", "away_sot_avg", "home_corners_avg", "away_corners_avg",
        "home_xg_avg", "away_xg_avg", "home_yc_avg", "away_yc_avg",
        "home_rc_avg", "away_rc_avg", "home_fouls_avg", "away_fouls_avg",
        "ref_pct_over25", "ref_style_open",
        "home_insidebox_avg", "away_insidebox_avg",
        "home_possession_avg", "away_possession_avg",
        "home_goals_r1_avg", "away_goals_r1_avg",
        "home_goals_r2_avg", "away_goals_r2_avg",
        "home_subs_avg", "away_subs_avg",
    ]
    for c in _new_feats:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df[_new_feats] = df[_new_feats].fillna(df[_new_feats].median())
    df["home_ht"] = df["home_ht_final"].fillna(0)
    df["away_ht"] = df["away_ht_final"].fillna(0)
    df["goals_ht"] = df["home_ht"] + df["away_ht"]
    df["home_r2"] = df["home_goals"] - df["home_ht"]
    df["away_r2"] = df["away_goals"] - df["away_ht"]
    df["goals_r2"] = df["home_r2"] + df["away_r2"]
    df["lambda_sum"] = df["lambda_home"].fillna(0) + df["lambda_away"].fillna(0)
    df["lambda_ratio"] = df["lambda_home"].fillna(0) / df["lambda_away"].replace(0, 1).fillna(1)
    df["elo_sum"] = df["home_elo"].fillna(1500) + df["away_elo"].fillna(1500)
    df["goals_home_current"] = df["home_ht"]
    df["goals_away_current"] = df["away_ht"]
    df["goal_diff_current"] = df["home_ht"] - df["away_ht"]
    for _pc in ["home_win_prob", "over15_prob", "over25_prob", "gg_prob"]:
        df[_pc] = pd.to_numeric(df[_pc], errors="coerce").fillna(50)
    df["y_over05"] = (df["home_goals"] + df["away_goals"] >= 1).astype(int)
    df["y_over15"] = (df["home_goals"] + df["away_goals"] >= 2).astype(int)
    df["y_over25"] = (df["home_goals"] + df["away_goals"] >= 3).astype(int)
    df["y_over35"] = (df["home_goals"] + df["away_goals"] >= 4).astype(int)
    df["y_over45"] = (df["home_goals"] + df["away_goals"] >= 5).astype(int)
    df["y_btts"]   = ((df["home_goals"] > 0) & (df["away_goals"] > 0)).astype(int)
    df["y_over05_home"] = (df["home_goals"] >= 1).astype(int)
    df["y_over05_away"] = (df["away_goals"] >= 1).astype(int)
    df["y_home_win"] = (df["result_winner"] == "home").astype(int)
    df["y_draw"]     = (df["result_winner"] == "draw").astype(int)
    df["y_away_win"] = (df["result_winner"] == "away").astype(int)
    df["y_ht_over05"] = (df["goals_ht"] >= 1).astype(int)
    df["y_ht_over15"] = (df["goals_ht"] >= 2).astype(int)
    df["y_ht_over25"] = (df["goals_ht"] >= 3).astype(int)
    df["y_ht_btts"]   = ((df["home_ht"] > 0) & (df["away_ht"] > 0)).astype(int)
    df["y_ht_home"]   = (df["home_ht"] >= 1).astype(int)
    df["y_ht_away"]   = (df["away_ht"] >= 1).astype(int)
    df["y_ht_home_over15"] = (df["home_ht"] >= 2).astype(int)
    df["y_ht_home_over25"] = (df["home_ht"] >= 3).astype(int)
    df["y_ht_away_over15"] = (df["away_ht"] >= 2).astype(int)
    df["y_ht_away_over25"] = (df["away_ht"] >= 3).astype(int)
    df["y_r2_over05"] = (df["goals_r2"] >= 1).astype(int)
    df["y_r2_over15"] = (df["goals_r2"] >= 2).astype(int)
    df["y_r2_over25"] = (df["goals_r2"] >= 3).astype(int)
    df["y_r2_btts"]   = ((df["home_r2"] > 0) & (df["away_r2"] > 0)).astype(int)
    df["y_r2_home"]   = (df["home_r2"] >= 1).astype(int)
    df["y_r2_away"]   = (df["away_r2"] >= 1).astype(int)
    df["y_r2_home_over15"] = (df["home_r2"] >= 2).astype(int)
    df["y_r2_home_over25"] = (df["home_r2"] >= 3).astype(int)
    df["y_r2_away_over15"] = (df["away_r2"] >= 2).astype(int)
    df["y_r2_away_over25"] = (df["away_r2"] >= 3).astype(int)
    df["y_r2_home_win"] = (df["home_r2"] > df["away_r2"]).astype(int)
    df["y_r2_draw"]     = (df["home_r2"] == df["away_r2"]).astype(int)
    df["y_r2_away_win"] = (df["away_r2"] > df["home_r2"]).astype(int)
    df["y_over15_home"] = (df["home_goals"] >= 2).astype(int)
    df["y_over25_home"] = (df["home_goals"] >= 3).astype(int)
    df["y_over15_away"] = (df["away_goals"] >= 2).astype(int)
    df["y_over25_away"] = (df["away_goals"] >= 3).astype(int)
    _ct = df["corners_home"] + df["corners_away"]
    df["y_corners_over85"]  = (_ct >= 9).astype(int).where(_ct.notna())
    df["y_corners_over95"]  = (_ct >= 10).astype(int).where(_ct.notna())
    df["y_corners_over105"] = (_ct >= 11).astype(int).where(_ct.notna())
    _ch, _ca = df["corners_home"], df["corners_away"]
    for thr, nm in [(4, "over35"), (5, "over45"), (6, "over55"), (7, "over65"), (8, "over75"), (9, "over85")]:
        df["y_corners_home_" + nm] = (_ch >= thr).astype(int).where(_ch.notna())
        df["y_corners_away_" + nm] = (_ca >= thr).astype(int).where(_ca.notna())
    _yt, _yh, _ya = df["yc_home"] + df["yc_away"], df["yc_home"], df["yc_away"]
    df["y_cards_over35"] = (_yt >= 4).astype(int).where(_yt.notna())
    df["y_cards_over45"] = (_yt >= 5).astype(int).where(_yt.notna())
    df["y_cards_over55"] = (_yt >= 6).astype(int).where(_yt.notna())
    df["y_cards_over65"] = (_yt >= 7).astype(int).where(_yt.notna())
    df["y_cards_home_over15"] = (_yh >= 2).astype(int).where(_yh.notna())
    df["y_cards_home_over25"] = (_yh >= 3).astype(int).where(_yh.notna())
    df["y_cards_home_over35"] = (_yh >= 4).astype(int).where(_yh.notna())
    df["y_cards_away_over15"] = (_ya >= 2).astype(int).where(_ya.notna())
    df["y_cards_away_over25"] = (_ya >= 3).astype(int).where(_ya.notna())
    df["y_cards_away_over35"] = (_ya >= 4).astype(int).where(_ya.notna())
    return df


def reliability(y, p):
    out = []
    for lo, hi in BUCKETS:
        m = (p >= lo) & (p < hi)
        n = int(m.sum())
        out.append((lo, hi, (float(p[m].mean()) if n else None), (float(y[m].mean()) if n else None), n))
    return out


# Calibrare 1 piață binară. X cronologic, y binar (poate conține NaN → eliminat).
def calibrate_binary(X, y):
    X = np.asarray(X, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    mask = ~np.isnan(y)
    X, y = X[mask], y[mask].astype(int)
    n = len(y)
    if n < MIN_TOTAL:
        return {"calibrated": False, "reason": "total <%d (%d)" % (MIN_TOTAL, n)}, None
    i1, i2 = int(n * 0.6), int(n * 0.8)
    Xtr, Xcal, Xte = X[:i1], X[i1:i2], X[i2:]
    ytr, ycal, yte = y[:i1], y[i1:i2], y[i2:]
    if len(np.unique(ytr)) < 2 or len(np.unique(ycal)) < 2 or len(np.unique(yte)) < 2:
        return {"calibrated": False, "reason": "o singură clasă în split"}, None
    if len(ycal) < MIN_CAL:
        return {"calibrated": False, "reason": "calib <%d (%d)" % (MIN_CAL, len(ycal))}, None
    sc = StandardScaler().fit(Xtr)
    lr = LogisticRegression(max_iter=1000).fit(sc.transform(Xtr), ytr)
    pcal = lr.predict_proba(sc.transform(Xcal))[:, 1]
    pte = lr.predict_proba(sc.transform(Xte))[:, 1]
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(pcal, ycal)
    pte_c = np.clip(iso.predict(pte), 0.01, 0.99)
    br_raw = float(brier_score_loss(yte, pte))
    br_cal = float(brier_score_loss(yte, pte_c))
    meta = {
        "n_cal": int(len(ycal)), "n_test": int(len(yte)),
        "brier_raw": round(br_raw, 5), "brier_cal": round(br_cal, 5),
        "rel_before": reliability(yte, pte), "rel_after": reliability(yte, pte_c),
    }
    # CRITERIU: dacă Brier nu se îmbunătățește (sau se înrăutățește) → identitate.
    if br_cal <= br_raw - 1e-6:
        x = [round(float(v), 5) for v in np.asarray(iso.X_thresholds_, dtype=float)]
        yk = [round(float(v), 5) for v in np.asarray(iso.y_thresholds_, dtype=float)]
        return {"calibrated": True, "x": x, "y": yk}, meta
    meta["reason"] = "Brier nu se îmbunătățește (raw=%.5f cal=%.5f)" % (br_raw, br_cal)
    return {"calibrated": False, "reason": meta["reason"]}, meta


# Calibrare MULTICLASS one-vs-rest: isotonic per clasă pe CALIB + renormalizare la sumă 1.
# Criteriu: log loss(TEST) trebuie să se îmbunătățească, altfel identitate. code2str = cod→etichetă.
def calibrate_multiclass(X, y, code2str):
    X = np.asarray(X, dtype=np.float64)
    y = np.asarray(y)
    mask = ~pd.isnull(y)
    X, y = X[mask], y[mask].astype(int)
    n = len(y)
    if n < MIN_TOTAL:
        return {"calibrated": False, "reason": "total <%d (%d)" % (MIN_TOTAL, n)}, None
    i1, i2 = int(n * 0.6), int(n * 0.8)
    Xtr, Xcal, Xte = X[:i1], X[i1:i2], X[i2:]
    ytr, ycal, yte = y[:i1], y[i1:i2], y[i2:]
    classes = np.unique(y)
    if len(classes) < 2:
        return {"calibrated": False, "reason": "o singură clasă"}, None
    counts = {int(c): int((ycal == c).sum()) for c in classes}
    if min(counts.values()) < MIN_CLASS:
        return {"calibrated": False, "reason": "clasă minoritară <%d în calib (%s)" % (MIN_CLASS, counts)}, None
    for split in (ytr, ycal, yte):
        if len(np.unique(split)) < len(classes):
            return {"calibrated": False, "reason": "clasă lipsă într-un split"}, None
    sc = StandardScaler().fit(Xtr)
    lr = LogisticRegression(multi_class="multinomial", max_iter=1000).fit(sc.transform(Xtr), ytr)
    cls = lr.classes_            # coduri int, sortate (ordinea coloanelor predict_proba)
    Pcal = lr.predict_proba(sc.transform(Xcal))
    Pte = lr.predict_proba(sc.transform(Xte))
    isos, rel_b, rel_a = {}, {}, {}
    cal_te = np.zeros_like(Pte)
    for j, c in enumerate(cls):
        iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0).fit(Pcal[:, j], (ycal == c).astype(int))
        cal_te[:, j] = np.clip(iso.predict(Pte[:, j]), 0.001, 0.999)
        s = code2str.get(int(c), str(int(c)))
        isos[s] = {"x": [round(float(v), 5) for v in np.asarray(iso.X_thresholds_, float)],
                   "y": [round(float(v), 5) for v in np.asarray(iso.y_thresholds_, float)]}
        rel_b[s] = reliability((yte == c).astype(float), Pte[:, j])
    # RENORMALIZARE la sumă 1 (echivalent largest-remainder pe scara 0-1; serving = norm3 la 100).
    rs = cal_te.sum(axis=1, keepdims=True); rs[rs == 0] = 1.0
    cal_te = cal_te / rs
    for j, c in enumerate(cls):
        rel_a[code2str.get(int(c), str(int(c)))] = reliability((yte == c).astype(float), cal_te[:, j])
    classes_str = [code2str.get(int(c), str(int(c))) for c in cls]
    cls_list = list(cls)
    ll_raw = float(log_loss(yte, Pte, labels=cls_list))
    ll_cal = float(log_loss(yte, cal_te, labels=cls_list))
    mb_raw = float(tl._multiclass_brier(yte, Pte, cls_list))
    mb_cal = float(tl._multiclass_brier(yte, cal_te, cls_list))
    meta = {"n_cal": int(len(ycal)), "n_test": int(len(yte)), "classes": classes_str,
            "ll_raw": round(ll_raw, 5), "ll_cal": round(ll_cal, 5),
            "mb_raw": round(mb_raw, 5), "mb_cal": round(mb_cal, 5),
            "rel_before": rel_b, "rel_after": rel_a}
    if ll_cal <= ll_raw - 1e-6:
        return {"calibrated": True, "multiclass": True, "classes": classes_str, "iso": isos}, meta
    meta["reason"] = "log loss nu se îmbunătățește (raw=%.5f cal=%.5f)" % (ll_raw, ll_cal)
    return {"calibrated": False, "reason": meta["reason"]}, meta


def _emit(name, key, desc, res, meta, example_sink):
    if res["calibrated"]:
        R("  [CALIBRAT]  %-24s brier %.5f→%.5f  (n_cal=%d)" %
          (key, meta["brier_raw"], meta["brier_cal"], meta["n_cal"]))
    else:
        extra = (" brier %.5f→%.5f" % (meta["brier_raw"], meta["brier_cal"])) if meta else ""
        R("  [identitate] %-24s %s%s" % (key, res.get("reason", ""), extra))
    if meta and (key in ("over15_total", "goals_total_over15")):
        example_sink.append((name, key, desc, meta))


def run_prematch():
    R("\n══════ PRE-MECI (model_export) ══════")
    # Zidul anti-cote și pe calibrare (paranoia): features nu conțin termeni de cote.
    conn = tm.get_conn()
    df = pd.read_sql(tm.QUERY, conn)
    conn.close()
    R("Date: %d predicții rezolvate (ORDER BY created_at ASC)" % len(df))
    df = prep_prematch(df)
    export, examples = {}, []
    for key, (ycol, feats, desc) in tm.MARKETS.items():
        try:
            X = df[feats].apply(pd.to_numeric, errors="coerce")
            X = X.fillna(X.median()).fillna(0).values
            y = pd.to_numeric(df[ycol], errors="coerce").values
            res, meta = calibrate_binary(X, y)
        except Exception as e:
            res, meta = {"calibrated": False, "reason": "eroare: %s" % e}, None
        export[key] = res
        _emit("pre", key, desc, res, meta, examples)
    export["_meta"] = {"model": "model_export.json", "method": "isotonic OOS temporal 60/20/20",
                       "clamp": [0.01, 0.99], "min_cal": MIN_CAL}
    with open(PRE_OUT, "w") as f:
        json.dump(export, f, indent=2)
    R("→ %s (%d piețe; %d calibrate)" % (PRE_OUT, len(tm.MARKETS),
      sum(1 for k, v in export.items() if isinstance(v, dict) and v.get("calibrated"))))
    return examples


def run_live():
    R("\n══════ LIVE (model_live_export) ══════")
    conn = tl.get_conn()
    fmap = tl.load_feature_map(conn)
    fmap_proc, _med, default_ff = tl.process_feature_map(fmap)
    cov = {"total": 0, "ml_features": 0, "elo_history": 0, "standings": 0, "referee": 0}
    export, examples, mc_examples = {}, [], []
    for half in ("r1", "r2"):
        X, _fid, labels, n, markets_h = tl.generate_half(conn, half, fmap_proc, default_ff, cov)
        R("  %s: %d snapshot-uri" % (half, n))
        for (mkey, _h, kind, _lbl) in markets_h:
            if kind != "bin":
                code2str = NG2STR if mkey.startswith("next_goal") else (RES2STR if mkey.startswith("result") else {})
                try:
                    res, meta = calibrate_multiclass(X, np.asarray(labels[mkey]), code2str)
                except Exception as e:
                    res, meta = {"calibrated": False, "reason": "eroare: %s" % e}, None
                export[mkey] = res
                if res.get("calibrated"):
                    R("  [CALIBRAT-mc] %-22s logloss %.5f→%.5f · mc-brier %.5f→%.5f" %
                      (mkey, meta["ll_raw"], meta["ll_cal"], meta["mb_raw"], meta["mb_cal"]))
                else:
                    extra = (" logloss %.5f→%.5f" % (meta["ll_raw"], meta["ll_cal"])) if (meta and "ll_raw" in meta) else ""
                    R("  [identitate] %-22s %s%s" % (mkey, res.get("reason", ""), extra))
                if meta and "ll_raw" in meta:
                    mc_examples.append((mkey, meta))
                continue
            try:
                y = np.asarray(labels[mkey], dtype=np.float64)
                res, meta = calibrate_binary(X, y)
            except Exception as e:
                res, meta = {"calibrated": False, "reason": "eroare: %s" % e}, None
            export[mkey] = res
            _emit("live", mkey, mkey, res, meta, examples)
        del X, labels
    conn.close()
    export["_meta"] = {"model": "model_live_export.json", "method": "isotonic OOS temporal 60/20/20",
                       "clamp": [0.01, 0.99], "min_cal": MIN_CAL, "min_class": MIN_CLASS,
                       "multiclass": "one-vs-rest isotonic + renormalizare (next_goal/result)"}
    with open(LIVE_OUT, "w") as f:
        json.dump(export, f, indent=2)
    R("→ %s (%d piețe; %d calibrate)" % (LIVE_OUT, len(export) - 1,
      sum(1 for k, v in export.items() if isinstance(v, dict) and v.get("calibrated"))))
    return examples, mc_examples


def _print_mc(mc):
    if not mc:
        return
    R("\n══════ MULTICLASS — log loss / Brier mc (înainte → după) ══════")
    R("%-16s %9s %9s | %9s %9s   n_test" % ("piață", "ll_raw", "ll_cal", "mb_raw", "mb_cal"))
    for key, meta in mc:
        R("%-16s %9.5f %9.5f | %9.5f %9.5f   %d" %
          (key, meta["ll_raw"], meta["ll_cal"], meta["mb_raw"], meta["mb_cal"], meta["n_test"]))
    for key, meta in mc:
        if key not in ("next_goal_r1", "next_goal_r2"):
            continue
        R("\n── Reliability per CLASĂ — %s ──" % key)
        for s in meta["classes"]:
            R("  clasă '%s':   bucket   pred_b   real_b   pred_a   real_a    n" % s)
            for (lo, hi, pb, rb, n), (_, _, pa, ra, _n2) in zip(meta["rel_before"][s], meta["rel_after"][s]):
                if not n:
                    R("    %.0f-%.0f      —        —        —        —        0" % (lo * 100, hi * 100)); continue
                R("    %.0f-%.0f      %.3f    %.3f    %.3f    %.3f    %d" %
                  (lo * 100, hi * 100, pb, rb, pa, ra, n))


def _print_example(examples):
    R("\n══════ EXEMPLU RELIABILITY — Over 1.5 ══════")
    if not examples:
        R("  (Over 1.5 indisponibil în această rulare)")
        return
    for name, key, desc, meta in examples:
        R("  %s · %s (%s)  Brier %.5f → %.5f" % (name, key, desc, meta["brier_raw"], meta["brier_cal"]))
        R("    bucket    pred_before  real_before  pred_after  real_after   n")
        for (lo, hi, pb, rb, n), (_, _, pa, ra, _n2) in zip(meta["rel_before"], meta["rel_after"]):
            if not n:
                R("    %.0f-%.0f       —            —            —           —          0" % (lo * 100, hi * 100)); continue
            R("    %.0f-%.0f       %.3f        %.3f        %.3f       %.3f       %d" %
              (lo * 100, hi * 100, pb, rb, pa, ra, n))


def main():
    R("CALIBRARE ML — isotonic, OOS temporal (zero leakage). %s" % pd.Timestamp.now())
    ex_pre = run_prematch()
    ex_live, mc = run_live()
    _print_example(ex_pre + ex_live)
    _print_mc(mc)
    with open(REPORT, "w") as f:
        f.write("\n".join(_report_lines) + "\n")
    R("\n✅ Raport: %s" % REPORT)


if __name__ == "__main__":
    main()
