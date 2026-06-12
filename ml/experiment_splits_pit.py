"""
ml/experiment_splits_pit.py — EXPERIMENT ML #2b: splits POINT-IN-TIME (testul CURAT).
READ-ONLY. NU atinge producția (train_model/train_live/crontab). Scrie DOAR în
ml/experiment_splits_pit_report.txt (+ stdout).

#2a (ml/experiment_splits.py) a ieșit verde DAR cu leakage: splits din `standings` = snapshot
CURENT, iar fereastra de test (ultimele 20%) = exact sezonul reflectat → câștig umflat,
acoperire doar 17.9%. Aici reconstruim splits-urile POINT-IN-TIME din fixtures_history:
pentru fiecare meci, doar meciurile FT ANTERIOARE (același sezon + aceeași ligă, înainte de
match_date) — fără nicio scurgere din viitor.

  home_ppg_home, home_gf_home, home_ga_home  ← meciurile ANTERIOARE de ACASĂ ale gazdei
  away_ppg_away, away_gf_away, away_ga_away  ← meciurile ANTERIOARE din DEPLASARE ale oaspetelui
  split_ppg_diff = home_ppg_home − away_ppg_away
  (minim MIN_GAMES=3 meciuri în split; altfel NaN→median)

Implementare EFICIENTĂ: perspective home/away + groupby cumulativ (cumsum − valoarea curentă =
suma ANTERIOARĂ) — vectorizat, FĂRĂ loop pe ~174k rânduri.

În aceeași rulare recalculăm și #2a (standings curent) pe ACELAȘI dataset → comparație onestă
#2a vs #2b: cât din câștig a fost leakage = Δ2a − Δ2b.

Rulare:  cd /root/scannerv2 && python3 -u ml/experiment_splits_pit.py
"""
import os
import sys

ML_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ML_DIR)

import numpy as np
import pandas as pd

import train_model as tm
import calibrate as cal
import experiment_splits as ex2a   # add_split_features (2a), fit_eval, NEW_FEATURES, KEY_MARKETS, WORSEN_TOL

REPORT = os.path.join(ML_DIR, "experiment_splits_pit_report.txt")
MIN_GAMES = 3
DONE = ("FT", "AET", "PEN")
NEW = ex2a.NEW_FEATURES          # nume plain (home_ppg_home, ...) — comune 2a/2b
KEY = ex2a.KEY_MARKETS
TOL = ex2a.WORSEN_TOL

FH_QUERY = """
SELECT fixture_id, league_id, season, home_team_id, away_team_id,
       home_goals, away_goals, match_date
  FROM fixtures_history
 WHERE status_short = ANY(%(done)s)
   AND home_goals IS NOT NULL AND away_goals IS NOT NULL
   AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL
   AND league_id IS NOT NULL AND season IS NOT NULL
"""

_rep = []
def R(s=""):
    print(s)
    _rep.append(s)


def _cum_prior(persp):
    """persp: DataFrame [fixture_id, team, league, season, date, pts, gf, ga].
    Întoarce, per rând, statistica ANTERIOARĂ (fără meciul curent) a echipei pe acea
    perspectivă (home sau away), via cumsum − valoarea curentă (stabil pe egalitate de dată)."""
    g = persp.sort_values(["team", "league", "season", "date", "fixture_id"]).reset_index(drop=True)
    grp = g.groupby(["team", "league", "season"], sort=False)
    g["pg"]  = grp.cumcount()                         # nr. meciuri ANTERIOARE (0-based = prior count)
    g["pp"]  = grp["pts"].cumsum() - g["pts"]         # puncte anterioare
    g["pgf"] = grp["gf"].cumsum()  - g["gf"]          # gf anterioare
    g["pga"] = grp["ga"].cumsum()  - g["ga"]          # ga anterioare
    return g


def _ratios(g, ppg, gf, ga):
    ok = g["pg"] >= MIN_GAMES
    den = g["pg"].where(g["pg"] > 0)
    return pd.DataFrame({
        "fixture_id": g["fixture_id"].values,
        ppg: np.where(ok, g["pp"] / den, np.nan),
        gf:  np.where(ok, g["pgf"] / den, np.nan),
        ga:  np.where(ok, g["pga"] / den, np.nan),
    })


def add_pit_features(df, suffix=""):
    """Adaugă cele 7 feature-uri PIT (point-in-time) la df (merge pe fixture_id).
    suffix permite coexistența cu feature-urile #2a (aceleași nume plain)."""
    conn = tm.get_conn()
    fh = pd.read_sql(FH_QUERY, conn, params={"done": list(DONE)})
    conn.close()
    fh["match_date"] = pd.to_datetime(fh["match_date"], utc=True, errors="coerce")
    for c in ["home_goals", "away_goals"]:
        fh[c] = pd.to_numeric(fh[c], errors="coerce")
    hg, ag = fh["home_goals"], fh["away_goals"]
    base = dict(fixture_id=fh["fixture_id"], league=fh["league_id"], season=fh["season"], date=fh["match_date"])
    hp = pd.DataFrame(dict(base, team=fh["home_team_id"],
                           pts=np.where(hg > ag, 3, np.where(hg == ag, 1, 0)),
                           gf=hg.astype(float), ga=ag.astype(float)))
    ap = pd.DataFrame(dict(base, team=fh["away_team_id"],
                           pts=np.where(ag > hg, 3, np.where(ag == hg, 1, 0)),
                           gf=ag.astype(float), ga=hg.astype(float)))
    hp, ap = _cum_prior(hp), _cum_prior(ap)
    s = suffix
    hres = _ratios(hp, "home_ppg_home" + s, "home_gf_home" + s, "home_ga_home" + s)
    ares = _ratios(ap, "away_ppg_away" + s, "away_gf_away" + s, "away_ga_away" + s)
    df = df.merge(hres, on="fixture_id", how="left").merge(ares, on="fixture_id", how="left")
    df["split_ppg_diff" + s] = df["home_ppg_home" + s] - df["away_ppg_away" + s]
    cov = int(df["home_ppg_home" + s].notna().sum())
    return df, cov


def main():
    R("EXPERIMENT SPLITS POINT-IN-TIME (#2b) — testul curat (%s)" % pd.Timestamp.now())
    tm.assert_no_odds(tm.FEATURES_PREMATCH + NEW)   # ZIDUL ANTI-COTE pe setul extins
    R("Zidul anti-cote: OK\n")

    conn = tm.get_conn()
    df = pd.read_sql(tm.QUERY, conn)
    conn.close()
    R("Date: %d predicții (ORDER BY created_at ASC)" % len(df))
    df = cal.prep_prematch(df)

    # #2a (standings curent) ȘI #2b (PIT) pe ACELAȘI dataset → comparație onestă.
    df, cov2a = ex2a.add_split_features(df)                 # nume plain (2a)
    df, cov2b = add_pit_features(df, suffix="_pit")         # nume sufixate (2b)
    feats2a = NEW
    feats2b = [n + "_pit" for n in NEW]
    n = len(df)
    R("Acoperire #2a (standings curent): %d/%d (%.1f%%)" % (cov2a, n, 100.0 * cov2a / max(n, 1)))
    R("Acoperire #2b (point-in-time):    %d/%d (%.1f%%)  [MIN_GAMES=%d]" % (cov2b, n, 100.0 * cov2b / max(n, 1), MIN_GAMES))
    R("")

    BASE = tm.FEATURES_PREMATCH
    R("%-15s %9s | %9s %+9s | %9s %+9s | %9s" %
      ("piață", "Brier_b", "Brier_2a", "Δ2a", "Brier_2b", "Δ2b", "leakage"))
    R("-" * 78)
    imp2b = 0; bad2b = 0; valid = 0; pit_models = {}
    for key in KEY:
        ycol = tm.MARKETS[key][0]
        bb = ex2a.fit_eval(df, BASE, ycol)[0]
        b2a = ex2a.fit_eval(df, BASE + feats2a, ycol)[0]
        r2b = ex2a.fit_eval(df, BASE + feats2b, ycol)
        b2b, lr2b = r2b[0], r2b[1]
        if bb is None or b2a is None or b2b is None:
            R("%-15s   (o singură clasă — sărit)" % key); continue
        valid += 1
        d2a = bb - b2a; d2b = bb - b2b; leak = d2a - d2b
        if d2b > 0: imp2b += 1
        if d2b < -TOL: bad2b += 1
        R("%-15s %9.5f | %9.5f %+9.5f | %9.5f %+9.5f | %+9.5f" % (key, bb, b2a, d2a, b2b, d2b, leak))
        pit_models[key] = (lr2b, BASE + feats2b)

    # Top feature-uri PIT (|coef| standardizat) — văd dacă semnalul curat „trage".
    R("\n── Top feature-uri PIT (|coef| standardizat, model #2b) ──")
    for key in KEY:
        if key not in pit_models: continue
        lr, feats = pit_models[key]
        coefs = lr.coef_[0]
        pairs = [(feats[i], coefs[i]) for i in range(len(feats)) if feats[i] in feats2b]
        pairs.sort(key=lambda t: -abs(t[1]))
        R("  %-15s %s" % (key, ", ".join("%s=%+.3f" % (nm, c) for nm, c in pairs[:3])))

    # VERDICT
    R("\n══════ VERDICT #2b (POINT-IN-TIME, fără leakage) ══════")
    R("Piețe-cheie: %d · îmbunătățite (#2b): %d · înrăutățite >%.4f: %d" % (valid, imp2b, TOL, bad2b))
    adopt = (valid > 0 and imp2b > valid / 2 and bad2b == 0)
    if adopt:
        R("➜ ADOPȚIE RECOMANDATĂ: câștigul rezistă POINT-IN-TIME (nu era doar leakage).")
        R("  Următor pas (o schimbare pe rând): adaugă feature-urile PIT în train_model.py +")
        R("  build-ml-features (materializare point-in-time) + reantrenare măsurată before/after.")
    else:
        R("➜ NU adopta: câștigul #2a a fost (în mare parte) LEAKAGE — point-in-time NU confirmă.")
    R("\nINTERPRETARE 'leakage' = Δ2a − Δ2b per piață: cât din câștigul aparent #2a a dispărut")
    R("când eliminăm scurgerea (valori mari pozitive = câștig fals din snapshot-ul curent).")
    R("NB: experiment READ-ONLY — producția (train_model/train_live/crontab) NEATINSĂ.")

    with open(REPORT, "w") as f:
        f.write("\n".join(_rep) + "\n")
    R("\n✅ Raport: %s" % REPORT)


if __name__ == "__main__":
    main()
