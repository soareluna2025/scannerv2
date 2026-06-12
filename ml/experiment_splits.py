"""
ml/experiment_splits.py — EXPERIMENT ML #2: splits acasă/deplasare ca feature-uri.
READ-ONLY (ca ml/experiment_elo.py). NU atinge producția (train_model/train_live/crontab).
Scrie DOAR în ml/experiment_splits_report.txt (+ stdout).

Ipoteză: forma DOAR de acasă a gazdei + DOAR din deplasare a oaspetelui = semnal mai curat
decât forma generală. Verdictul (before/after, OOS temporal) decide adopția — ca la ELO HOME_ADV.

Reutilizare (import, nu copy-paste):
  • train_model: QUERY, FEATURES_PREMATCH, MARKETS, get_conn, assert_no_odds (ZIDUL ANTI-COTE).
  • calibrate.prep_prematch: derivările + labels (mirror fidel al train_model.main).

⚠ LEAKAGE / LIMITARE (documentată explicit): tabela `standings` are UN SINGUR snapshot per
   (echipă, ligă, sezon) = clasamentul CURENT (colectat zilnic), NU point-in-time dinaintea
   fiecărui meci. Deci feature-urile de splits folosesc starea de la SFÂRȘIT (sau curentă),
   nu cea de dinaintea meciului → ușoară SCURGERE din viitor + acoperire parțială (doar
   meciurile al căror (echipă,ligă,sezon) e în standings azi). Verdictul e SUGESTIV (limită
   superioară optimistă); adopția reală cere splits POINT-IN-TIME (istoric de standings).

Rulare:  cd /root/scannerv2 && python3 -u ml/experiment_splits.py
"""
import os
import sys

ML_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ML_DIR)

import numpy as np
import pandas as pd
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss

import train_model as tm     # QUERY, FEATURES_PREMATCH, MARKETS, get_conn, assert_no_odds
import calibrate as cal      # prep_prematch (derivări + labels)

REPORT = os.path.join(ML_DIR, "experiment_splits_report.txt")
SPLIT_FRAC = 0.8             # split TEMPORAL train/test (paritate cu train_model.main)
KEY_MARKETS = ["over15_total", "over25_total", "home_win", "away_win", "btts_total"]
NEW_FEATURES = [
    "home_ppg_home", "away_ppg_away",
    "home_gf_home", "home_ga_home", "away_gf_away", "away_ga_away",
    "split_ppg_diff",
]
WORSEN_TOL = 0.0005          # înrăutățire maximă tolerată pe o piață-cheie

# Splits agregate (UN rând per echipă/ligă/sezon — MAX colapsează dublurile de grupă WC).
SPLITS_QUERY = """
WITH st AS (
  SELECT team_id, league_id, season,
         MAX(played_home) pl_h, MAX(win_home) w_h, MAX(draw_home) d_h, MAX(gf_home) gf_h, MAX(ga_home) ga_h,
         MAX(played_away) pl_a, MAX(win_away) w_a, MAX(draw_away) d_a, MAX(gf_away) gf_a, MAX(ga_away) ga_a
    FROM standings GROUP BY team_id, league_id, season
)
SELECT p.fixture_id,
       sh.pl_h AS h_pl, sh.w_h AS h_w, sh.d_h AS h_d, sh.gf_h AS h_gf, sh.ga_h AS h_ga,
       sa.pl_a AS a_pl, sa.w_a AS a_w, sa.d_a AS a_d, sa.gf_a AS a_gf, sa.ga_a AS a_ga
  FROM predictions p
  JOIN fixtures_history fh ON fh.fixture_id = p.fixture_id
  LEFT JOIN st sh ON sh.team_id = fh.home_team_id AND sh.league_id = fh.league_id AND sh.season = fh.season
  LEFT JOIN st sa ON sa.team_id = fh.away_team_id AND sa.league_id = fh.league_id AND sa.season = fh.season
 WHERE p.result_winner IS NOT NULL
"""

_rep = []
def R(s=""):
    print(s)
    _rep.append(s)


def add_split_features(df):
    """Adaugă cele 7 feature-uri de splits din standings (merge pe fixture_id)."""
    conn = tm.get_conn()
    sdf = pd.read_sql(SPLITS_QUERY, conn)
    conn.close()
    df = df.merge(sdf, on="fixture_id", how="left")
    for c in ["h_pl", "h_w", "h_d", "h_gf", "h_ga", "a_pl", "a_w", "a_d", "a_gf", "a_ga"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    hpl = df["h_pl"].where(df["h_pl"] > 0)
    apl = df["a_pl"].where(df["a_pl"] > 0)
    df["home_ppg_home"] = (df["h_w"] * 3 + df["h_d"]) / hpl
    df["home_gf_home"]  = df["h_gf"] / hpl
    df["home_ga_home"]  = df["h_ga"] / hpl
    df["away_ppg_away"] = (df["a_w"] * 3 + df["a_d"]) / apl
    df["away_gf_away"]  = df["a_gf"] / apl
    df["away_ga_away"]  = df["a_ga"] / apl
    df["split_ppg_diff"] = df["home_ppg_home"] - df["away_ppg_away"]
    cov = int(df["home_ppg_home"].notna().sum())
    return df, cov


def fit_eval(df, feats, ycol):
    """Train pe primele SPLIT_FRAC (temporal), Brier pe restul. Întoarce (brier, lr, scaler, feats)."""
    X = df[feats].apply(pd.to_numeric, errors="coerce")
    X = X.fillna(X.median()).fillna(0).values
    y = pd.to_numeric(df[ycol], errors="coerce").values
    mask = ~np.isnan(y)
    X, y = X[mask], y[mask].astype(int)
    n = len(y)
    i = int(n * SPLIT_FRAC)
    Xtr, Xte, ytr, yte = X[:i], X[i:], y[:i], y[i:]
    if len(np.unique(ytr)) < 2 or len(np.unique(yte)) < 2:
        return None, None, None, None, n
    sc = StandardScaler().fit(Xtr)
    lr = LogisticRegression(max_iter=1000).fit(sc.transform(Xtr), ytr)
    p = lr.predict_proba(sc.transform(Xte))[:, 1]
    return float(brier_score_loss(yte, p)), lr, sc, feats, len(yte)


def main():
    R("EXPERIMENT SPLITS — acasă/deplasare ca feature-uri (%s)" % pd.Timestamp.now())
    assert_feats = tm.FEATURES_PREMATCH + NEW_FEATURES
    tm.assert_no_odds(assert_feats)   # ZIDUL ANTI-COTE peste setul extins
    R("Zidul anti-cote: OK (%d feature-uri verificate)" % len(assert_feats))

    conn = tm.get_conn()
    df = pd.read_sql(tm.QUERY, conn)
    conn.close()
    R("Date: %d predicții (ORDER BY created_at ASC)" % len(df))
    df = cal.prep_prematch(df)
    df, cov = add_split_features(df)
    pct = (100.0 * cov / len(df)) if len(df) else 0.0
    R("Acoperire splits (non-NaN home_ppg_home): %d/%d (%.1f%%) — restul → median (neutru)." % (cov, len(df), pct))
    R("⚠ LIMITARE: standings = snapshot CURENT (nu point-in-time) → ușoară scurgere; verdict SUGESTIV.\n")

    BASE = tm.FEATURES_PREMATCH
    EXP = tm.FEATURES_PREMATCH + NEW_FEATURES
    R("%-16s %10s %10s %10s   verdict" % ("piață", "Brier_base", "Brier_exp", "Δ(b-e)"))
    R("-" * 62)
    improved = 0
    worsened_bad = 0
    valid = 0
    exp_models = {}
    for key in KEY_MARKETS:
        ycol = tm.MARKETS[key][0]
        bb, _, _, _, ntb = fit_eval(df, BASE, ycol)
        be, lr, sc, _, nte = fit_eval(df, EXP, ycol)
        if bb is None or be is None:
            R("%-16s   (o singură clasă în split — sărit)" % key); continue
        valid += 1
        delta = bb - be
        if delta > 0: improved += 1
        if delta < -WORSEN_TOL: worsened_bad += 1
        vv = "✅ mai bun" if delta > 0 else ("⚠ înrăutățit >tol" if delta < -WORSEN_TOL else "≈ neutru")
        R("%-16s %10.5f %10.5f %+10.5f   %s" % (key, bb, be, delta, vv))
        exp_models[key] = (lr, sc, EXP)

    # Top features NOI (după |coef| standardizat) — vedem dacă splits-urile „trag".
    R("\n── Top feature-uri NOI (|coef| standardizat, model EXPERIMENT) ──")
    for key in KEY_MARKETS:
        if key not in exp_models: continue
        lr, sc, feats = exp_models[key]
        coefs = lr.coef_[0]
        pairs = [(feats[i], coefs[i]) for i in range(len(feats)) if feats[i] in NEW_FEATURES]
        pairs.sort(key=lambda t: -abs(t[1]))
        top = ", ".join("%s=%+.3f" % (n, c) for n, c in pairs[:3])
        R("  %-16s %s" % (key, top))

    # VERDICT
    R("\n══════ VERDICT ══════")
    R("Piețe-cheie evaluate: %d · îmbunătățite: %d · înrăutățite >%.4f: %d" %
      (valid, improved, WORSEN_TOL, worsened_bad))
    adopt = (valid > 0 and improved > valid / 2 and worsened_bad == 0)
    if adopt:
        R("➜ ADOPȚIE RECOMANDATĂ (după confirmare point-in-time): îmbunătățire pe majoritate,")
        R("  fără înrăutățire >%.4f pe vreo piață. Următor pas: splits POINT-IN-TIME (fără leakage)." % WORSEN_TOL)
    else:
        R("➜ NU adopta acum: criteriul (majoritate îmbunătățită + 0 înrăutățiri >%.4f) NU e îndeplinit," % WORSEN_TOL)
        R("  SAU semnalul e diluat de acoperirea/leakage-ul standings-ului curent.")
    R("\nNB: experiment READ-ONLY — producția (train_model/train_live/crontab) NEATINSĂ.")

    with open(REPORT, "w") as f:
        f.write("\n".join(_rep) + "\n")
    R("\n✅ Raport: %s" % REPORT)


if __name__ == "__main__":
    main()
