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
import shutil
import gc
import resource
from array import array
import numpy as np
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
ORDER BY fh.match_date, me.fixture_id, me.elapsed, COALESCE(me.elapsed_extra, 0), me.id
"""


# ── Vectorul de features (IDENTIC pentru toate piețele) ──────────────────────
# 16 base (din snapshot, reconstrucție live) + 25 pre-meci (din DB, point-in-time).
# ORDINEA E CONTRACT cu inferența (api/ml-predict.js buildLiveFeaturesV2).
BASE_FEATURES = [
    "elapsed_norm", "is_r2", "home_goals_now", "away_goals_now", "goal_diff",
    "goals_total_now", "home_yc_now", "away_yc_now", "home_rc_now", "away_rc_now",
    "total_yc_now", "total_rc_now", "home_subs_now", "away_subs_now",
    "minutes_remaining", "score_state",
]
# 25 features pre-meci, ÎN ORDINEA EXACTĂ cerută (A ml_features, B elo, C standings, D referee).
NEW_FEATURES = [
    # A) ml_features (18) — medii istorice rolling-100 point-in-time
    "home_yc_avg", "away_yc_avg",
    "home_fouls_avg", "away_fouls_avg",
    "home_corners_avg", "away_corners_avg",
    "home_possession_avg", "away_possession_avg",
    "home_sot_avg", "away_sot_avg",
    "home_xg_avg", "away_xg_avg",
    "home_goals_r1_avg", "away_goals_r1_avg",
    "home_goals_r2_avg", "away_goals_r2_avg",
    "home_subs_avg", "away_subs_avg",
    # B) elo_history (3) — snapshot ELO pre-meci (fără lookahead)
    "home_elo", "away_elo", "elo_diff",
    # C) standings (2) — poziție normalizată (rank-1)/(max_rank-1)
    "home_position_norm", "away_position_norm",
    # D) referee_stats (2) — avg galbene + stil deschis
    "ref_yc_avg", "ref_style_open",
]
FEATURES = BASE_FEATURES + NEW_FEATURES   # 16 + 25 = 41

# Query per-fixture pentru cele 25 features pre-meci (LEFT JOIN, point-in-time pe
# fixture_id; standings/referee = snapshot CURENT, aproximare documentată).
FEATURE_QUERY = """
SELECT
  fh.fixture_id,
  mlf.home_yc_avg, mlf.away_yc_avg,
  mlf.home_fouls_avg, mlf.away_fouls_avg,
  mlf.home_corners_avg, mlf.away_corners_avg,
  mlf.home_possession_avg, mlf.away_possession_avg,
  mlf.home_sot_avg, mlf.away_sot_avg,
  mlf.home_xg_avg, mlf.away_xg_avg,
  mlf.home_goals_r1_avg, mlf.away_goals_r1_avg,
  mlf.home_goals_r2_avg, mlf.away_goals_r2_avg,
  mlf.home_subs_avg, mlf.away_subs_avg,
  eh.home_elo, eh.away_elo, eh.elo_diff,
  CASE WHEN sh.rank IS NOT NULL AND mr.max_rank > 1
       THEN (sh.rank - 1.0) / (mr.max_rank - 1.0) END AS home_position_norm,
  CASE WHEN sa.rank IS NOT NULL AND mr.max_rank > 1
       THEN (sa.rank - 1.0) / (mr.max_rank - 1.0) END AS away_position_norm,
  rs.avg_yellow_cards AS ref_yc_avg,
  CASE WHEN rs.referee_name IS NULL THEN NULL
       WHEN rs.referee_style = 'open' THEN 1 ELSE 0 END AS ref_style_open
FROM fixtures_history fh
LEFT JOIN ml_features mlf ON mlf.fixture_id = fh.fixture_id
LEFT JOIN elo_history  eh  ON eh.fixture_id = fh.fixture_id
LEFT JOIN (SELECT league_id, season, team_id, MIN(rank) AS rank
             FROM standings GROUP BY league_id, season, team_id) sh
       ON sh.league_id = fh.league_id AND sh.season = fh.season AND sh.team_id = fh.home_team_id
LEFT JOIN (SELECT league_id, season, team_id, MIN(rank) AS rank
             FROM standings GROUP BY league_id, season, team_id) sa
       ON sa.league_id = fh.league_id AND sa.season = fh.season AND sa.team_id = fh.away_team_id
LEFT JOIN (SELECT league_id, season, MAX(rank) AS max_rank
             FROM standings GROUP BY league_id, season) mr
       ON mr.league_id = fh.league_id AND mr.season = fh.season
LEFT JOIN referee_stats rs ON rs.referee_name = fh.referee
WHERE fh.match_date >= '2023-01-01'
  AND fh.home_goals IS NOT NULL AND fh.away_goals IS NOT NULL
  AND fh.home_team_id IS NOT NULL AND fh.away_team_id IS NOT NULL
"""


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


# ════════ MANAGEMENT MEMORIE (OOM-safe pe VPS 2GB) ════════════════════════════
# Snapshot-urile NU se mai acumulează ca liste de dicturi (overhead ~20x), ci
# direct în buffere compacte: X = array('f') float32, labels = array('b') int8.
# Procesare SECVENȚIALĂ: R1 complet (generare→antrenare→free) apoi R2. Niciodată
# ambele seturi în memorie. build_snapshots (logica de etichetare) e NEATINSĂ.

# Encodare compactă a label-urilor 3-clase (storage int8); decodate la string
# ÎNAINTE de antrenare → `classes` din export rămân identice ('1'/'X'/'2',
# 'home'/'away'/'none'). Doar STORAGE-ul e compact; logica e neschimbată.
RESULT_DECODE = ["1", "X", "2"]
RESULT_CODE = {"1": 0, "X": 1, "2": 2}
NG_DECODE = ["home", "away", "none"]
NG_CODE = {"home": 0, "away": 1, "none": 2}

COV_KEYS = ["ml_features", "elo_history", "standings", "referee"]
_COV_IDX = [
    NEW_FEATURES.index("home_sot_avg"),        # ml_features
    NEW_FEATURES.index("home_elo"),            # elo_history
    NEW_FEATURES.index("home_position_norm"),  # standings
    NEW_FEATURES.index("ref_yc_avg"),          # referee
]


def _rss_mb():
    # ru_maxrss e în KB pe Linux → MB.
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def load_feature_map(conn):
    """{fixture_id: np.float32[25]} (NaN pt lipsă) — cele 25 features pre-meci."""
    cur = conn.cursor()
    cur.execute(FEATURE_QUERY)
    names = [d[0] for d in cur.description][1:]
    assert names == NEW_FEATURES, f"FEATURE_QUERY != NEW_FEATURES:\n{names}\n{NEW_FEATURES}"
    fmap = {}
    for row in cur:
        fmap[int(row[0])] = np.array(
            [np.nan if v is None else float(v) for v in row[1:]], dtype=np.float32)
    cur.close()
    return fmap


def process_feature_map(fmap):
    """Calculează medianele (nanmedian pe fixtures), pre-umple NaN → mediană, și
    precalculează flag-urile de coverage per fixture. Întoarce
    (proc{fid:(filled_np25, flags)}, medians_np25, default_ff)."""
    if fmap:
        M = np.vstack(list(fmap.values()))
        med = np.nanmedian(M, axis=0)
        del M
    else:
        med = np.zeros(len(NEW_FEATURES), dtype=np.float32)
    med = np.where(np.isnan(med), 0.0, med).astype(np.float32)
    proc = {}
    for fid, arr in fmap.items():
        flags = tuple(bool(not np.isnan(arr[i])) for i in _COV_IDX)
        proc[fid] = (np.where(np.isnan(arr), med, arr).astype(np.float32), flags)
    return proc, med, (med.copy(), (False, False, False, False))


def generate_half(conn, half, fmap_proc, default_ff, cov_counts):
    """Generează snapshot-urile UNEI reprize în buffere compacte (X float32 +
    label int8 per piață + fixture_id). build_snapshots e apelat per fixture și
    rândurile sunt filtrate pe is_r2 — celelalte aruncate imediat."""
    is_r2_target = 1 if half == "r2" else 0
    markets_h = [m for m in MARKETS if m[1] == half]
    nfeat = len(FEATURES)
    Xbuf = array('f')
    fid_list = []
    lbufs = {m[0]: array('b') for m in markets_h}
    state = {"n": 0, "cur_fid": None, "events": [], "meta": None}

    def flush():
        cf, meta, events = state["cur_fid"], state["meta"], state["events"]
        if cf is None or meta is None or not events:
            return
        rows = build_snapshots(events, *meta)          # LOGICĂ NEATINSĂ
        if not rows:
            return
        filled, flags = fmap_proc.get(int(cf), default_ff)
        filled_list = filled.tolist()
        for row in rows:
            if row["is_r2"] != is_r2_target:
                continue
            for f in BASE_FEATURES:
                Xbuf.append(float(row[f]))             # 16 base
            Xbuf.extend(filled_list)                   # 25 pre-meci (pre-umplute)
            fid_list.append(int(cf))
            for (mkey, _h, kind, label_col) in markets_h:
                if kind == "multi":
                    code = (NG_CODE[row["next_goal_side"]] if label_col == "next_goal_side"
                            else RESULT_CODE[row[label_col]])
                    lbufs[mkey].append(code)
                else:
                    lbufs[mkey].append(int(row[label_col]))
            cov_counts["total"] += 1
            for i, k in enumerate(COV_KEYS):
                if flags[i]:
                    cov_counts[k] += 1
            state["n"] += 1

    cur = conn.cursor()
    cur.execute(QUERY)
    for r in cur:
        (fid, elapsed, ee, etype, detail, team_id,
         home_id, away_id, fhg, fag, hht, aht) = r
        if fid != state["cur_fid"]:
            flush()
            state["cur_fid"] = fid
            state["events"] = []
            state["meta"] = (
                int(home_id), int(away_id), int(fhg), int(fag),
                None if hht is None else int(hht),
                None if aht is None else int(aht),
            )
        state["events"].append({
            "elapsed": int(elapsed),
            "elapsed_extra": int(ee or 0),
            "type": etype,
            "detail": detail,
            "team_id": None if team_id is None else int(team_id),
        })
    flush()
    cur.close()

    n = state["n"]
    if n:
        X = np.frombuffer(Xbuf, dtype=np.float32).reshape(-1, nfeat)
    else:
        X = np.zeros((0, nfeat), dtype=np.float32)
    fid = np.asarray(fid_list, dtype=np.int32)
    labels = {k: np.frombuffer(v, dtype=np.int8) for k, v in lbufs.items()}
    return X, fid, labels, n, markets_h


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


def train_market(key, kind, X, y, n):
    """X = matricea (deja filtrată pe reprize) float32; y = labels (int pt binar,
    string pt 3-clase, deja DECODAT). Logica train/test + scaler + LR + Brier e
    IDENTICĂ cu versiunea pandas (doar sursa datelor diferă: numpy, nu DataFrame)."""
    if n < MIN_SAMPLES:
        return None, f"  {key:<22} SKIP — doar {n} snapshot-uri (<{MIN_SAMPLES})"

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
    uniq, counts = np.unique(y, return_counts=True)
    if len(uniq) < 2:
        return None, f"  {key:<22} SKIP — o singură clasă în label"
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


def _train_half(half_name, X, fid, labels, markets_h, n, final):
    """Antrenează toate piețele unei reprize din buffere numpy. Decodează
    label-urile 3-clase (int8→string) ÎNAINTE de antrenare → `classes` neschimbate."""
    print(f"--- {half_name} (snapshots {'>45' if markets_h and markets_h[0][1]=='r2' else '<=45'}) ---")
    for (mkey, _half, kind, label_col) in markets_h:
        yc = labels[mkey]
        if kind == "multi":
            decode = NG_DECODE if label_col == "next_goal_side" else RESULT_DECODE
            y = np.asarray(decode, dtype=object)[yc.astype(int)]   # int8 → string
        else:
            y = yc
        model, line = train_market(mkey, kind, X, y, n)
        print(line)
        if model is not None:
            final[mkey] = model


def main():
    print("AlohaScan — antrenare model LIVE (minut-cu-minut)\n")
    conn = get_conn()

    # Feature map (25 pre-meci) + mediane + flags coverage — memorie mică (per-fixture).
    fmap = load_feature_map(conn)
    fmap_proc, med, default_ff = process_feature_map(fmap)
    del fmap
    gc.collect()
    feature_medians = {NEW_FEATURES[i]: round(float(med[i]), 6) for i in range(len(NEW_FEATURES))}
    print(f"[mem] după feature map: RSS={_rss_mb():.0f}MB  fixturi={len(fmap_proc)}")

    cov_counts = {"total": 0, "ml_features": 0, "elo_history": 0, "standings": 0, "referee": 0}
    final = {}
    print("\n=== Rezultate per piață ===")

    # ── REPRIZA 1 (generare → antrenare → eliberare) ─────────────────────────
    Xr1, fidr1, labr1, nr1, mk_r1 = generate_half(conn, "r1", fmap_proc, default_ff, cov_counts)
    print(f"[mem] după generare R1: RSS={_rss_mb():.0f}MB  rows={nr1}")
    _train_half("Repriza 1", Xr1, fidr1, labr1, mk_r1, nr1, final)
    del Xr1, fidr1, labr1
    gc.collect()
    print(f"[mem] după antrenare R1: RSS={_rss_mb():.0f}MB")

    # ── REPRIZA 2 / final (generare → antrenare → eliberare) ─────────────────
    Xr2, fidr2, labr2, nr2, mk_r2 = generate_half(conn, "r2", fmap_proc, default_ff, cov_counts)
    # Plasă de siguranță OPȚIONALĂ: păstrează doar cele mai RECENTE N snapshots R2
    # (QUERY e ordonat pe match_date → „recent" = ultimele rânduri). Default: off.
    _maxr2 = os.getenv("MAX_SNAPSHOTS_R2")
    if _maxr2:
        _maxr2 = int(_maxr2)
        if nr2 > _maxr2:
            Xr2 = np.ascontiguousarray(Xr2[-_maxr2:])
            fidr2 = fidr2[-_maxr2:]
            labr2 = {k: v[-_maxr2:] for k, v in labr2.items()}
            nr2 = _maxr2
            gc.collect()
            print(f"[cap] R2 limitat la {_maxr2} cele mai recente snapshots")
    print(f"[mem] după generare R2: RSS={_rss_mb():.0f}MB  rows={nr2}")
    _train_half("Repriza 2 / final", Xr2, fidr2, labr2, mk_r2, nr2, final)
    del Xr2, fidr2, labr2
    gc.collect()
    conn.close()

    if cov_counts["total"] == 0:
        print("⚠ Niciun snapshot generat — verifică match_events / fixtures_history.")
        return

    # ── Coverage % per sursă (pe snapshots, în timpul generării) ─────────────
    tot = max(1, cov_counts["total"])
    coverage = {k: round(100.0 * cov_counts[k] / tot, 1) for k in COV_KEYS}
    print("\n=== Coverage features pre-meci (snapshots cu date reale, pre-fillna) ===")
    print(f"  ml_features:  {coverage['ml_features']:.1f}%")
    print(f"  elo_history:  {coverage['elo_history']:.1f}%")
    print(f"  standings:    {coverage['standings']:.1f}%")
    print(f"  referee:      {coverage['referee']:.1f}%")

    # Backup export vechi ÎNAINTE de scriere (comparație Brier înainte/după).
    if os.path.exists(EXPORT_PATH):
        prev = EXPORT_PATH.replace(".json", ".prev.json")
        try:
            shutil.copy(EXPORT_PATH, prev)
            print(f"↩ Backup export vechi → {prev}")
        except Exception as e:
            print(f"⚠ Nu am putut salva backup-ul vechi: {e}")

    final["_feature_medians"] = feature_medians
    final["_coverage"] = {**coverage, "n_features": len(FEATURES)}

    with open(EXPORT_PATH, "w") as f:
        json.dump(final, f, indent=2)
    n_markets = sum(1 for k in final if not k.startswith("_"))
    print(f"\n✅ Export: {EXPORT_PATH}  ({n_markets} piețe, {len(FEATURES)} features)")
    print(f"[mem] final: RSS={_rss_mb():.0f}MB (țintă < 1200MB)")
    print("Notă: model SEPARAT — NU atinge model_export.json (pre-meci).")


if __name__ == "__main__":
    main()
