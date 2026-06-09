"""
AlohaScan — Antrenare model ML LIVE (minut-cu-minut), SEPARAT de pre-meci.

Reconstruiește starea fiecărui meci la fiecare eveniment din `match_events`
(gol / cartonaș / substituire, cu minutul real = elapsed + elapsed_extra) și
creează câte un SNAPSHOT per eveniment. Pe aceste snapshot-uri antrenează
modele LogisticRegression separate pe piețe de Repriza 1 (snapshots elapsed<=45)
și Repriza 2 / final (snapshots elapsed>45), apoi exportă TOTUL în
ml/model_live_export.json — structură identică cu ml/model_export.json.

⚠ NU atinge ml/model_export.json, train_model.py, calcConfidence*, score1-7.
   Acesta e un pipeline COMPLET separat (output: model_live_export.json).

⚠ SECURITATE: conexiunea DB se ia din VARIABILE DE MEDIU (nu hardcodăm parola):
     export POSTGRES_URL="postgresql://alohascan:***@127.0.0.1:5432/elefant"
   sau  export PGPASSWORD=*** PGUSER=alohascan PGDATABASE=elefant PGHOST=127.0.0.1

⚠ SCHEMA REALĂ:
   match_events(fixture_id, elapsed, elapsed_extra, team_id, type, detail, ...)
   fixtures_history(fixture_id, home_team_id, away_team_id, home_goals,
                    away_goals, home_ht, away_ht, match_date)
   Convenție API-Football:
     type   ∈ {'Goal','Card','subst','Var'}
     Goal detail: 'Normal Goal','Penalty','Own Goal','Missed Penalty'
        → 'Missed Penalty' NU e gol; 'Own Goal' se creditează ADVERSARULUI.
     Card detail: 'Yellow Card','Red Card','Second Yellow card'
        → 'Second Yellow card' = ROȘU (acumulare).

Rulare:  python3 ml/train_live_v2.py        (NU rulează automat din cron)
"""

import os
import json
import numpy as np
import pandas as pd
import psycopg2
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.metrics import brier_score_loss
from sklearn.preprocessing import StandardScaler

ML_DIR = os.path.dirname(os.path.abspath(__file__))
EXPORT_PATH = os.path.join(ML_DIR, "model_live_export.json")


def _load_env_file(path="/root/scannerv2/.env"):
    # Încarcă manual KEY=VALUE din .env (fără python-dotenv). Doar cheile absente.
    try:
        with open(path, "r") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
    except FileNotFoundError:
        pass
    except Exception:
        pass


def get_conn():
    _load_env_file()
    url = os.getenv("POSTGRES_URL")
    if url:
        return psycopg2.connect(url)
    return psycopg2.connect(
        dbname=os.getenv("PGDATABASE", "elefant"),
        user=os.getenv("PGUSER", "alohascan"),
        password=os.getenv("PGPASSWORD"),
        host=os.getenv("PGHOST", "127.0.0.1"),
        port=os.getenv("PGPORT", "5432"),
    )


# Evenimente + label-uri de meci, doar 2023+, elapsed>=0, scor final cunoscut.
# Ordonat pe (fixture_id, elapsed, elapsed_extra, id) ca reconstrucția să fie
# strict cronologică.
QUERY = """
SELECT
    me.fixture_id,
    me.elapsed,
    COALESCE(me.elapsed_extra, 0) AS elapsed_extra,
    me.type,
    me.detail,
    me.team_id,
    fh.home_team_id,
    fh.away_team_id,
    fh.home_goals,
    fh.away_goals,
    fh.home_ht,
    fh.away_ht
FROM match_events me
JOIN fixtures_history fh ON fh.fixture_id = me.fixture_id
WHERE fh.match_date >= '2023-01-01'
  AND me.elapsed >= 0
  AND fh.home_goals IS NOT NULL
  AND fh.away_goals IS NOT NULL
  AND fh.home_team_id IS NOT NULL
  AND fh.away_team_id IS NOT NULL
ORDER BY me.fixture_id, me.elapsed, COALESCE(me.elapsed_extra, 0), me.id
"""


# ── Vectorul de features (IDENTIC pentru toate piețele) ──────────────────────
FEATURES = [
    "elapsed_norm", "is_r2", "home_goals_now", "away_goals_now", "goal_diff",
    "goals_total_now", "home_yc_now", "away_yc_now", "home_rc_now", "away_rc_now",
    "total_yc_now", "total_rc_now", "home_subs_now", "away_subs_now",
    "minutes_remaining", "score_state",
]


def _goal_side(ev_type, detail, team_id, home_id, away_id):
    """Întoarce 'home'/'away'/None pentru un eveniment, cu reguli API-Football:
    'Missed Penalty' NU e gol; 'Own Goal' se creditează echipei adverse."""
    if ev_type != "Goal":
        return None
    d = (detail or "").strip().lower()
    if d == "missed penalty":
        return None
    if d == "own goal":
        if team_id == home_id:
            return "away"
        if team_id == away_id:
            return "home"
        return None
    if team_id == home_id:
        return "home"
    if team_id == away_id:
        return "away"
    return None


def _card_kind(ev_type, detail):
    """'yc' pentru galben, 'rc' pentru roșu (inclusiv al 2-lea galben), altfel None."""
    if ev_type != "Card":
        return None
    d = (detail or "").strip().lower()
    if "second yellow" in d or "red" in d:
        return "rc"
    if "yellow" in d:
        return "yc"
    return None


def _is_subst(ev_type):
    return (ev_type or "").strip().lower() == "subst"


def _side_of_team(team_id, home_id, away_id):
    if team_id == home_id:
        return "home"
    if team_id == away_id:
        return "away"
    return None


def _result(h, a):
    if h > a:
        return "1"
    if h < a:
        return "2"
    return "X"


def build_snapshots(events, home_id, away_id, final_home, final_away, ht_home, ht_away):
    """Pentru un meci: listă de dict-uri (un snapshot per eveniment), cu features
    + toate label-urile de piață. Label-urile de meci sunt constante; next_goal_*
    e per-snapshot (cine marchează următorul gol DUPĂ momentul curent)."""
    n = len(events)
    if n == 0:
        return []

    # Latura golului pentru fiecare eveniment (sau None dacă nu e gol valid).
    goal_sides = [
        _goal_side(e["type"], e["detail"], e["team_id"], home_id, away_id)
        for e in events
    ]

    # next_goal după fiecare index (strict mai târziu). Parcurgere inversă.
    next_after = ["none"] * n
    nxt = "none"
    for i in range(n - 1, -1, -1):
        next_after[i] = nxt
        if goal_sides[i] is not None:
            nxt = goal_sides[i]

    # HT goluri: preferă coloanele autoritare; fallback = numără goluri elapsed<=45.
    if ht_home is None or ht_away is None:
        ch = sum(1 for i, e in enumerate(events) if e["elapsed"] <= 45 and goal_sides[i] == "home")
        ca = sum(1 for i, e in enumerate(events) if e["elapsed"] <= 45 and goal_sides[i] == "away")
        ht_home = ch if ht_home is None else ht_home
        ht_away = ca if ht_away is None else ht_away

    # Cartonașe: total la HT (elapsed<=45) și total pe tot meciul (pentru label-uri).
    ht_cards_total = sum(
        1 for e in events if e["elapsed"] <= 45 and _card_kind(e["type"], e["detail"]) is not None
    )
    final_cards_total = sum(
        1 for e in events if _card_kind(e["type"], e["detail"]) is not None
    )

    # ── Label-uri de meci (constante pe toate snapshot-urile meciului) ────────
    r2_home = final_home - ht_home
    r2_away = final_away - ht_away
    r2_total = r2_home + r2_away
    ht_total = ht_home + ht_away
    final_total = final_home + final_away

    match_labels = {
        # ── R1 ──
        "result_r1": _result(ht_home, ht_away),                      # 3 clase
        "goals_r1_over05": int(ht_total > 0.5),
        "goals_r1_over15": int(ht_total > 1.5),
        "goals_r1_over25": int(ht_total > 2.5),
        "home_goals_r1_over05": int(ht_home > 0.5),
        "home_goals_r1_over15": int(ht_home > 1.5),
        "home_goals_r1_over25": int(ht_home > 2.5),
        "away_goals_r1_over05": int(ht_away > 0.5),
        "away_goals_r1_over15": int(ht_away > 1.5),
        "away_goals_r1_over25": int(ht_away > 2.5),
        "cards_r1_over15": int(ht_cards_total > 1.5),
        "cards_r1_over25": int(ht_cards_total > 2.5),
        "cards_r1_over35": int(ht_cards_total > 3.5),
        "btts_r1": int(ht_home > 0 and ht_away > 0),
        # ── R2 / final ──
        "result_final": _result(final_home, final_away),             # 3 clase
        "goals_total_over15": int(final_total > 1.5),
        "goals_total_over25": int(final_total > 2.5),
        "goals_total_over35": int(final_total > 3.5),
        "goals_total_over45": int(final_total > 4.5),
        "goals_r2_over05": int(r2_total > 0.5),
        "goals_r2_over15": int(r2_total > 1.5),
        "home_goals_r2_over05": int(r2_home > 0.5),
        "home_goals_r2_over15": int(r2_home > 1.5),
        "away_goals_r2_over05": int(r2_away > 0.5),
        "away_goals_r2_over15": int(r2_away > 1.5),
        "btts_final": int(final_home > 0 and final_away > 0),
        "cards_total_over35": int(final_cards_total > 3.5),
        "cards_total_over45": int(final_cards_total > 4.5),
        "cards_total_over55": int(final_cards_total > 5.5),
    }

    # ── Reconstrucția stării pas-cu-pas + emiterea snapshot-urilor ───────────
    hg = ag = 0           # goluri curente
    hyc = ayc = 0         # galbene curente
    hrc = arc = 0         # roșii curente (inclusiv al 2-lea galben)
    hsub = asub = 0       # substituiri curente
    rows = []
    for i, e in enumerate(events):
        # aplică evenimentul i la starea curentă
        gs = goal_sides[i]
        if gs == "home":
            hg += 1
        elif gs == "away":
            ag += 1
        ck = _card_kind(e["type"], e["detail"])
        if ck is not None:
            side = _side_of_team(e["team_id"], home_id, away_id)
            if ck == "yc":
                if side == "home":
                    hyc += 1
                elif side == "away":
                    ayc += 1
            else:  # rc
                if side == "home":
                    hrc += 1
                elif side == "away":
                    arc += 1
        if _is_subst(e["type"]):
            side = _side_of_team(e["team_id"], home_id, away_id)
            if side == "home":
                hsub += 1
            elif side == "away":
                asub += 1

        elapsed = e["elapsed"]
        is_r2 = 1 if elapsed > 45 else 0
        goal_diff = hg - ag
        score_state = 1 if hg > ag else (-1 if ag > hg else 0)

        row = {
            # features
            "elapsed_norm": min(1.0, elapsed / 90.0),
            "is_r2": is_r2,
            "home_goals_now": hg,
            "away_goals_now": ag,
            "goal_diff": goal_diff,
            "goals_total_now": hg + ag,
            "home_yc_now": hyc,
            "away_yc_now": ayc,
            "home_rc_now": hrc,
            "away_rc_now": arc,
            "total_yc_now": hyc + ayc,
            "total_rc_now": hrc + arc,
            "home_subs_now": hsub,
            "away_subs_now": asub,
            "minutes_remaining": max(0, 90 - elapsed),
            "score_state": score_state,
            # per-snapshot next goal (folosit de next_goal_r1 / next_goal_r2)
            "next_goal_side": next_after[i],
        }
        row.update(match_labels)
        rows.append(row)

    return rows


def load_dataset():
    conn = get_conn()
    cur = conn.cursor()
    cur.execute(QUERY)
    all_rows = []
    cur_fid = None
    events = []
    meta = None  # (home_id, away_id, final_home, final_away, ht_home, ht_away)
    n_matches = 0

    def flush():
        nonlocal n_matches
        if cur_fid is None or meta is None or not events:
            return
        snaps = build_snapshots(events, *meta)
        if snaps:
            all_rows.extend(snaps)
            n_matches += 1

    for r in cur:
        (fid, elapsed, ee, etype, detail, team_id,
         home_id, away_id, fhg, fag, hht, aht) = r
        if fid != cur_fid:
            flush()
            cur_fid = fid
            events = []
            meta = (
                int(home_id), int(away_id), int(fhg), int(fag),
                None if hht is None else int(hht),
                None if aht is None else int(aht),
            )
        events.append({
            "elapsed": int(elapsed),
            "elapsed_extra": int(ee or 0),
            "type": etype,
            "detail": detail,
            "team_id": None if team_id is None else int(team_id),
        })
    flush()
    cur.close()
    conn.close()
    print(f"Meciuri procesate: {n_matches} | snapshot-uri generate: {len(all_rows)}")
    return pd.DataFrame(all_rows), n_matches


# ── Definiția piețelor: (key, half, kind, label_col) ─────────────────────────
#   half ∈ {'r1','r2'} → filtrează snapshot-urile (is_r2==0 / ==1)
#   kind ∈ {'bin','multi'}
MARKETS = [
    # ── R1 (snapshots elapsed<=45) ──
    ("result_r1",            "r1", "multi", "result_r1"),
    ("goals_r1_over05",      "r1", "bin",   "goals_r1_over05"),
    ("goals_r1_over15",      "r1", "bin",   "goals_r1_over15"),
    ("goals_r1_over25",      "r1", "bin",   "goals_r1_over25"),
    ("home_goals_r1_over05", "r1", "bin",   "home_goals_r1_over05"),
    ("home_goals_r1_over15", "r1", "bin",   "home_goals_r1_over15"),
    ("home_goals_r1_over25", "r1", "bin",   "home_goals_r1_over25"),
    ("away_goals_r1_over05", "r1", "bin",   "away_goals_r1_over05"),
    ("away_goals_r1_over15", "r1", "bin",   "away_goals_r1_over15"),
    ("away_goals_r1_over25", "r1", "bin",   "away_goals_r1_over25"),
    ("cards_r1_over15",      "r1", "bin",   "cards_r1_over15"),
    ("cards_r1_over25",      "r1", "bin",   "cards_r1_over25"),
    ("cards_r1_over35",      "r1", "bin",   "cards_r1_over35"),
    ("btts_r1",              "r1", "bin",   "btts_r1"),
    ("next_goal_r1",         "r1", "multi", "next_goal_side"),
    # ── R2 / final (snapshots elapsed>45) ──
    ("result_final",         "r2", "multi", "result_final"),
    ("goals_total_over15",   "r2", "bin",   "goals_total_over15"),
    ("goals_total_over25",   "r2", "bin",   "goals_total_over25"),
    ("goals_total_over35",   "r2", "bin",   "goals_total_over35"),
    ("goals_total_over45",   "r2", "bin",   "goals_total_over45"),
    ("goals_r2_over05",      "r2", "bin",   "goals_r2_over05"),
    ("goals_r2_over15",      "r2", "bin",   "goals_r2_over15"),
    ("home_goals_r2_over05", "r2", "bin",   "home_goals_r2_over05"),
    ("home_goals_r2_over15", "r2", "bin",   "home_goals_r2_over15"),
    ("away_goals_r2_over05", "r2", "bin",   "away_goals_r2_over05"),
    ("away_goals_r2_over15", "r2", "bin",   "away_goals_r2_over15"),
    ("btts_final",           "r2", "bin",   "btts_final"),
    ("next_goal_r2",         "r2", "multi", "next_goal_side"),
    ("cards_total_over35",   "r2", "bin",   "cards_total_over35"),
    ("cards_total_over45",   "r2", "bin",   "cards_total_over45"),
    ("cards_total_over55",   "r2", "bin",   "cards_total_over55"),
]

MIN_SAMPLES = 200   # sub atât, piața nu e antrenabilă fiabil


def _multiclass_brier(y_labels, proba, classes):
    idx = {c: i for i, c in enumerate(classes)}
    Y = np.zeros_like(proba, dtype=float)
    for r, lab in enumerate(y_labels):
        Y[r, idx[lab]] = 1.0
    return float(np.mean(np.sum((proba - Y) ** 2, axis=1)))


def train_market(key, half, kind, label_col, df):
    sub = df[df["is_r2"] == (1 if half == "r2" else 0)]
    n = len(sub)
    if n < MIN_SAMPLES:
        return None, f"  {key:<22} SKIP — doar {n} snapshot-uri (<{MIN_SAMPLES})"

    X = sub[FEATURES].to_numpy(dtype=float)
    y = sub[label_col].to_numpy()

    if kind == "bin":
        y = y.astype(int)
        if len(np.unique(y)) < 2:
            return None, f"  {key:<22} SKIP — o singură clasă în label"
        base_rate = float(y.mean())
        strat = y if np.bincount(y).min() >= 2 else None
        Xtr, Xte, ytr, yte = train_test_split(
            X, y, test_size=0.2, random_state=42, stratify=strat
        )
        scaler = StandardScaler().fit(Xtr)
        lr = LogisticRegression(max_iter=1000).fit(scaler.transform(Xtr), ytr)
        proba = lr.predict_proba(scaler.transform(Xte))[:, 1]
        brier = float(brier_score_loss(yte, proba))
        out = {
            "features": FEATURES,
            "lr_coef": lr.coef_[0].tolist(),
            "lr_intercept": float(lr.intercept_[0]),
            "scaler_mean": scaler.mean_.tolist(),
            "scaler_scale": scaler.scale_.tolist(),
            "base_rate": round(base_rate, 4),
            "n_samples": int(n),
            "brier_lr": round(brier, 4),
        }
        line = (f"  {key:<22} N={n:<7} base_rate={base_rate:.3f}  "
                f"brier_lr={brier:.4f}")
        return out, line

    # ── multiclass (3 clase) ──
    classes = sorted(pd.unique(y).tolist())
    if len(classes) < 2:
        return None, f"  {key:<22} SKIP — o singură clasă în label"
    counts = pd.Series(y).value_counts()
    base_rate = float(counts.max() / n)   # frecvența clasei majoritare
    strat = y if counts.min() >= 2 else None
    Xtr, Xte, ytr, yte = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=strat
    )
    scaler = StandardScaler().fit(Xtr)
    lr = LogisticRegression(
        multi_class="multinomial", max_iter=1000
    ).fit(scaler.transform(Xtr), ytr)
    proba = lr.predict_proba(scaler.transform(Xte))
    model_classes = lr.classes_.tolist()
    brier = _multiclass_brier(yte, proba, model_classes)
    out = {
        "features": FEATURES,
        "lr_coef": [row.tolist() for row in lr.coef_],         # (n_clase × n_feat)
        "lr_intercept": lr.intercept_.tolist(),                # (n_clase,)
        "scaler_mean": scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        "base_rate": round(base_rate, 4),
        "n_samples": int(n),
        "brier_lr": round(brier, 4),
        "classes": model_classes,
    }
    line = (f"  {key:<22} N={n:<7} base_rate={base_rate:.3f}  "
            f"brier_lr={brier:.4f}  classes={model_classes}")
    return out, line


def main():
    print("AlohaScan — antrenare model LIVE (minut-cu-minut)\n")
    df, n_matches = load_dataset()
    if df.empty or n_matches == 0:
        print("⚠ Niciun snapshot generat — verifică match_events / fixtures_history.")
        return

    final = {}
    print("\n=== Rezultate per piață ===")
    print("--- Reprize 1 (snapshots elapsed<=45) ---")
    half_printed_r2 = False
    for key, half, kind, label_col in MARKETS:
        if half == "r2" and not half_printed_r2:
            print("--- Repriza 2 / final (snapshots elapsed>45) ---")
            half_printed_r2 = True
        model, line = train_market(key, half, kind, label_col, df)
        print(line)
        if model is not None:
            final[key] = model

    with open(EXPORT_PATH, "w") as f:
        json.dump(final, f, indent=2)
    print(f"\n✅ Export: {EXPORT_PATH}  ({len(final)} piețe antrenate)")
    print("Notă: model SEPARAT — NU atinge model_export.json (pre-meci).")


if __name__ == "__main__":
    main()
