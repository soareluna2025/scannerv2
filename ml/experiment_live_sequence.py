#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
experiment_live_sequence.py — EXPERIMENT (NU producție, NU înlocuiește nimic).

Model SECVENȚIAL (GRU) care prezice „următorul gol în următoarele 10 minute" în
meciuri live, ca ALTERNATIVĂ de cercetare la heuristica Poisson live actuală
(api/utils/live-score.js · calcNextGoal / calcNextGoalWindow).

  • 3 clase la minutul T: {0 = GAZDELE înscriu în (T, T+10'],
                           1 = OASPEȚII înscriu,
                           2 = niciun gol}  (după PRIMUL gol din fereastră)
  • intrare GRU: secvența de stări minut-cu-minut (scor, momentum live, roșii,
    schimbări, intensitate recentă) + context static (ELO point-in-time, tier ligă)
    + embeddings învățate (echipă gazdă / oaspete / ligă).

NU atinge motorul validat (calcConfidence*, Poisson/Maher, Monte Carlo, ml-predict,
WebSocket, crontab). Heuristica JS e DOAR citită/portată pt baseline, nu modificată.

────────────────────────────────────────────────────────────────────────────────
PIPELINE (pași separați prin flag-uri CLI)
────────────────────────────────────────────────────────────────────────────────
  --extract   citește DB (VPS), reconstruiește secvențele, exportă dataset .npz
              portabil + meta .json (encoders + scaler). Suportă --limit / --seasons.
  --smoke     dovadă cap-coadă pe CPU (subset mic, 1-2 epoci) → train rapid + eval.
  --train     antrenare completă (Colab GPU): încarcă .npz, FĂRĂ DB.
  --eval      Brier multiclass + reliability + tabel vs baseline heuristic.
  --merge     concatenează mai multe shard-uri .npz (extras pe sezoane) într-unul.

Exemple (toate pe O singură linie — vezi README_live_sequence.md):
  python3 ml/experiment_live_sequence.py --extract --limit 60 --out ml/live_seq_smoke.npz
  python3 ml/experiment_live_sequence.py --smoke --data ml/live_seq_smoke.npz
  python3 ml/experiment_live_sequence.py --train --data ml/live_seq_full.npz --ckpt ml/live_seq.pt
  python3 ml/experiment_live_sequence.py --eval  --data ml/live_seq_full.npz --ckpt ml/live_seq.pt

Dependență NOUĂ, IZOLATĂ (nu strică mediul appului): torch (CPU pt smoke).
Vezi ml/requirements_live_sequence.txt + venv în README.
"""

import os
import sys
import json
import math
import time
import argparse
import datetime

# numpy e necesar peste tot; torch doar pt smoke/train/eval (nu pt --extract pur).
import numpy as np

# ════════════════════════════════════════════════════════════════════════════
#  CONFIG — toți parametrii sus
# ════════════════════════════════════════════════════════════════════════════
CONFIG = {
    # ── etichetă / fereastră ──
    "label_window_min": 10,        # „următorul gol în următoarele 10'"
    "t_min": 5,                    # nu eșantionăm sub minutul 5 (zgomot)
    "t_max": 85,                   # nici peste 85 (fereastra ar depăși 95')
    "minute_stride": 6,            # pas 6' (rărit din 3 -> ~2× mai puține eșantioane)
    "seq_cap": 30,                 # GRU vede ULTIMELE 30 stări-minut

    # ── focalizare / split temporal pe SEZON (anti-leakage) ──
    # v1 focalizat pe sezoanele recente. Un fixture aparține unui singur sezon =>
    # niciodată în ambele split-uri.
    "focus_seasons": [2024, 2025, 2026],   # extragem DOAR astea (override la --seasons)
    "test_seasons": [2026],                # TEST = 2026 ; TRAIN = 2024 + 2025
    "test_frac": 0.20,                     # folosit doar dacă test_seasons=None
    "val_frac_time": 0.15,         # ultima felie temporală din train (2025) → validare

    # ── encoders ──
    "min_team_freq": 30,           # echipe sub acest nr de apariții => bucket UNK
    "min_league_freq": 20,

    # ── model ──
    "emb_team_dim": 16,
    "emb_league_dim": 8,
    "gru_hidden": 96,
    "gru_layers": 1,
    "gru_dropout": 0.0,            # folosit doar dacă gru_layers > 1
    "mlp_hidden": 64,
    "dropout": 0.2,

    # ── antrenare ──
    "epochs": 25,
    "batch_size": 256,
    "lr": 1e-3,
    "weight_decay": 1e-5,
    "seed": 1337,

    # ── smoke (override-uri) ──
    "smoke_epochs": 2,
    "smoke_batch_size": 128,

    # ── MOD RAPID CPU (--fast) ──
    "early_stopping": False,       # activat de --fast: oprește pe val Brier
    "es_patience": 2,              # N epoci fără îmbunătățire => stop
    "es_min_delta": 1e-4,          # îmbunătățire minimă val Brier mc
    "fast_epochs": 12,             # plafon epoci în mod rapid
    "fast_batch_size": 1024,       # batch mare = throughput CPU
    "fast_gru_hidden": 64,         # model mic pt CPU
    "fast_gru_layers": 1,

    # ── DB ──
    "env_path": "/root/scannerv2/.env",
    "done_status": ("FT", "AET", "PEN"),
    "exclude_league_ids": (10,),   # league_id=10 = youth/amicale (regulă ML), exclus

    # ── I/O ──
    "seq_dtype": "float16",        # secvențele pe disc (valori mici, exacte în fp16)
    "flush_fixtures": 4000,        # extract incremental: progres/flush la fiecare N fixturi

    # ── baseline Poisson clasic (fără xG) — priors de fotbal pt shrink ──
    "poisson_prior_goals": 2.7,    # goluri/90 medii (prior)
    "poisson_prior_min": 90.0,     # pseudo-minute de shrink (1 meci)
    "poisson_home_share": 0.55,    # share gazdă în prior
}

# Numele feature-urilor DINAMICE (ordine fixă; salvate în meta). v1 FĂRĂ MOMENTUM
# (live_stats scos complet — acoperă <0.5% din date). Doar semnale din match_events. 12 col.
DYN_FEATURES = [
    "minute", "half2_flag", "goalless_flag",
    "home_goals", "away_goals", "goal_diff", "total_goals",
    "min_since_last_goal",
    "reds_home", "reds_away", "subs_home", "subs_away",
]
# Feature-uri STATICE (ordine fixă). 4 coloane.
STATIC_FEATURES = ["home_elo", "away_elo", "elo_diff", "league_tier"]

N_CLASSES = 3


# ════════════════════════════════════════════════════════════════════════════
#  Utilitare: env, DB, memorie
# ════════════════════════════════════════════════════════════════════════════
def _load_env(path=None):
    """Încarcă .env (REFOLOSIRE pattern din ml/experiment_elo.py / test_accuracy.py)."""
    path = path or CONFIG["env_path"]
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except FileNotFoundError:
        pass


def get_conn():
    import psycopg2  # import local: --train/--eval nu au nevoie de DB
    _load_env()
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


def _rss_mb():
    """RSS în MB (pt print [mem] pe VPS 2GB)."""
    try:
        import resource
        kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        # Linux raportează în KB
        return kb / 1024.0
    except Exception:
        return float("nan")


def log(msg):
    print("[%s] [mem %6.0fMB] %s" % (
        datetime.datetime.now().strftime("%H:%M:%S"), _rss_mb(), msg), flush=True)


# ════════════════════════════════════════════════════════════════════════════
#  BASELINE — port FIDEL al heuristicii live (api/utils/live-score.js)
# ════════════════════════════════════════════════════════════════════════════
def calc_next_goal_window(txg, mn, home_form=0.35, away_form=0.35, window=10):
    """
    IDENTIC cu calcNextGoalWindow(f, window) din api/utils/live-score.js.
    Întoarce P(orice gol în următoarele `window` minute) ca procent (0..60 cap).
    Default-urile de formă (0.35) = exact fd-defaults din live-score.js calcFeatures.
    """
    rem_time = min(window, max(0, 90 - mn))
    if rem_time <= 0:
        return 3.0
    if txg and txg > 0:
        rem_xg = (txg / max(mn, 1)) * rem_time
    else:
        rem_frac_window = rem_time / 90.0
        rem_xg = ((home_form + away_form) / 2.0 * 2.5) * rem_frac_window
    if mn >= 80:
        rem_xg *= 1.15
    elif mn >= 70:
        rem_xg *= 1.2
    prob = 1 - math.exp(-max(rem_xg, 0.03))
    return round(max(3, min(60, prob * 100)))


def baseline_distribution(home_xg, away_xg, mn):
    """
    Heuristica e nativ BINARĂ („orice gol"). O proiectăm pe 3 clase:
      p_any = calcNextGoalWindow(txg, T, 10)/100
      cota gazdă/oaspete = share de xG live (fallback 0.5/0.5)
      => [p_any*share_home, p_any*share_away, 1-p_any]
    Comparația cheie rămâne și pe varianta BINARĂ (gol vs niciun gol) = cel mai
    apples-to-apples față de heuristică.
    """
    txg = (home_xg or 0.0) + (away_xg or 0.0)
    p_any = calc_next_goal_window(txg, mn, window=CONFIG["label_window_min"]) / 100.0
    if txg > 0:
        sh = (home_xg or 0.0) / txg
    else:
        sh = 0.5
    sa = 1.0 - sh
    return np.array([p_any * sh, p_any * sa, 1.0 - p_any], dtype=np.float32)


# ════════════════════════════════════════════════════════════════════════════
#  EXTRACT — reconstrucție secvențe din DB
# ════════════════════════════════════════════════════════════════════════════
def _pool_from_where(seasons):
    """
    Sursa POOL-ului = BACKFILL: fixtures_history ∩ match_events(goluri), NU `fixtures`
    (acela are doar ~2508 rânduri live/recent → max 27). Cerințe: are evenimente +
    rezultat final (home/away_goals NOT NULL) + season. elo_history/leagues = LEFT JOIN
    cu fallback (1500 / tier 3). live_stats NU mai e filtru — momentum e OPȚIONAL
    (NULL-safe în _build_match_states). Întoarce (from_where_sql, params).
    """
    excl = ",".join(str(int(x)) for x in CONFIG["exclude_league_ids"]) or "-1"
    season_clause = ""
    params = []
    if seasons:
        season_clause = "AND fh.season = ANY(%s)"
        params.append(list(seasons))
    where = """
          FROM fixtures_history fh
          LEFT JOIN elo_history eh ON eh.fixture_id = fh.fixture_id
          LEFT JOIN leagues     lg ON lg.league_id  = fh.league_id
         WHERE fh.season IS NOT NULL
           AND fh.home_goals IS NOT NULL AND fh.away_goals IS NOT NULL
           AND fh.league_id NOT IN (%s)
           AND EXISTS (SELECT 1 FROM match_events me
                        WHERE me.fixture_id = fh.fixture_id AND me.type='Goal')
           %s
    """ % (excl, season_clause)
    return where, params


def _samples_per_fixture():
    return len(range(CONFIG["t_min"], CONFIG["t_max"] + 1, CONFIG["minute_stride"]))


def _fetch_pool(cur, limit, seasons):
    """Pool ancorat pe BACKFILL (fixtures_history). Dedupe pe fixture_id (DISTINCT ON)."""
    where, params = _pool_from_where(seasons)
    # DISTINCT ON dedupe (fixtures_history are PK pe `id`, fixture_id se poate repeta),
    # apoi reordonare CRONOLOGICĂ (match_date ASC) pt split temporal corect.
    sql = """
        SELECT * FROM (
          SELECT DISTINCT ON (fh.fixture_id)
                 fh.fixture_id, fh.season, fh.league_id,
                 fh.home_team_id, fh.away_team_id,
                 COALESCE(eh.home_elo, 1500)  AS home_elo,
                 COALESCE(eh.away_elo, 1500)  AS away_elo,
                 COALESCE(eh.elo_diff, 0)     AS elo_diff,
                 COALESCE(lg.tier, 3)         AS tier,
                 fh.match_date
          %s
          ORDER BY fh.fixture_id, fh.match_date DESC
        ) q ORDER BY q.match_date ASC
    """ % where
    if limit:
        sql += " LIMIT %s"
        params = params + [int(limit)]
    cur.execute(sql, params)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def _fetch_events(cur, fid):
    cur.execute(
        """SELECT elapsed, team_id, type, COALESCE(detail,'') AS detail
             FROM match_events
            WHERE fixture_id=%s AND elapsed IS NOT NULL
            ORDER BY elapsed ASC, id ASC""", (fid,))
    return cur.fetchall()


def _build_match_states(meta, events):
    """
    Construiește matricea de stări minut-cu-minut M[1..t_max] (listă de vectori
    DYN_FEATURES) + scor cumulativ pt etichete. Returnează (states, goals_timeline).
    goals_timeline = listă (elapsed, side) cu side 0=home,1=away.
    v1 FĂRĂ MOMENTUM — doar semnale din match_events (scor/timing/roșii/schimbări).
    """
    hid, aid = meta["home_team_id"], meta["away_team_id"]

    # cronologie goluri (după team_id, convenția casei: own-goals NEcorectate)
    goals = []
    for (elp, tid, typ, det) in events:
        if typ == "Goal" and elp is not None:
            side = 0 if tid == hid else (1 if tid == aid else None)
            if side is not None:
                goals.append((int(elp), side))
    goals.sort()

    t_max = CONFIG["t_max"]
    states = []
    for m in range(1, t_max + 1):
        hg = sum(1 for (e, s) in goals if e <= m and s == 0)
        ag = sum(1 for (e, s) in goals if e <= m and s == 1)
        last_goal_m = max([e for (e, s) in goals if e <= m], default=0)
        min_since_goal = float(m - last_goal_m)  # =m dacă niciun gol încă

        reds_h = reds_a = subs_h = subs_a = 0
        for (elp, tid, typ, det) in events:
            if elp is None or elp > m:
                continue
            is_red = (typ == "Card" and ("Red" in det or "Second Yellow" in det))
            is_sub = (typ in ("subst", "Subst", "substitution"))
            if is_red:
                if tid == hid:
                    reds_h += 1
                elif tid == aid:
                    reds_a += 1
            if is_sub:
                if tid == hid:
                    subs_h += 1
                elif tid == aid:
                    subs_a += 1

        vec = [
            float(m),                              # minute
            1.0 if m > 45 else 0.0,                # half2_flag
            1.0 if (hg + ag) == 0 else 0.0,        # goalless_flag
            float(hg), float(ag), float(hg - ag), float(hg + ag),  # scor + diff + total
            min_since_goal,                        # timing: minute de la ultimul gol
            float(reds_h), float(reds_a), float(subs_h), float(subs_a),
        ]
        states.append(vec)
    return states, goals


def _label_at(goals, T):
    """Primul gol în (T, T+W] => clasa; altfel 2 (niciun gol)."""
    W = CONFIG["label_window_min"]
    in_win = [(e, s) for (e, s) in goals if T < e <= T + W]
    if not in_win:
        return 2
    in_win.sort()
    return in_win[0][1]  # side 0=home,1=away


def cmd_count(args):
    """
    Raportează NUMĂRUL REAL (fără să construiască dataset, fără torch): câte fixturi
    eligibile pe BACKFILL, ~câte eșantioane, distribuția pe sezon. Pt decizia de scală.
    """
    seasons = None
    if args.seasons:
        seasons = [int(s) for s in args.seasons.split(",") if s.strip()]
    where, params = _pool_from_where(seasons)
    conn = get_conn()
    cur = conn.cursor()

    cur.execute("SELECT COUNT(DISTINCT fh.fixture_id) %s" % where, params)
    nfix = int(cur.fetchone()[0])
    spf = _samples_per_fixture()
    log("POOL backfill (fixtures_history ∩ match_events, momentum OPȚIONAL):")
    log("  fixturi eligibile           = %d" % nfix)
    log("  eșantioane/fixtur (T %d..%d pas %d) = %d" % (
        CONFIG["t_min"], CONFIG["t_max"], CONFIG["minute_stride"], spf))
    log("  ~eșantioane TOTAL            = %d" % (nfix * spf))

    cur.execute(
        "SELECT fh.season, COUNT(DISTINCT fh.fixture_id) %s GROUP BY fh.season ORDER BY fh.season"
        % where, params)
    log("  distribuție pe sezon:")
    for season, c in cur.fetchall():
        log("    %s : %6d fixturi  (~%d eșantioane)" % (season, int(c), int(c) * spf))

    # câte au momentum (live_stats) vs elo — pur informativ
    cur.execute(
        """SELECT
             COUNT(DISTINCT fh.fixture_id) FILTER (WHERE EXISTS
                (SELECT 1 FROM live_stats ls WHERE ls.fixture_id=fh.fixture_id)) AS with_live,
             COUNT(DISTINCT fh.fixture_id) FILTER (WHERE EXISTS
                (SELECT 1 FROM elo_history eh2 WHERE eh2.fixture_id=fh.fixture_id)) AS with_elo
           %s""" % where, params)
    wl, we = cur.fetchone()
    log("  din care: cu momentum live_stats = %d | cu elo_history = %d (rest fallback 1500)" % (
        int(wl or 0), int(we or 0)))
    cur.close()
    conn.close()


# ── DATASET I/O (DIRECTOR de .npy-uri; X_seq memmap pt RAM mic pe VPS 2GB) ──
DATASET_KEYS = ["X_seq", "X_len", "X_static", "home_team_id", "away_team_id",
                "league_id", "y", "baseline", "season", "fixture_id", "minute"]
# dtype-uri compacte (secvențele = fp16; restul minim necesar)
SMALL_DTYPE = {
    "X_len": np.int16, "X_static": np.float32,
    "home_team_id": np.int64, "away_team_id": np.int64, "league_id": np.int64,
    "y": np.int8, "baseline": np.float16,
    "season": np.int16, "fixture_id": np.int64, "minute": np.int16,
}


def _ds_dir(path):
    return path[:-1] if path.endswith("/") else path


def load_dataset(path, mmap=False):
    """Încarcă dataset din DIRECTOR (.npy) — X_seq memmap dacă mmap=True — sau .npz (compat)."""
    if os.path.isdir(path):
        out = {}
        for k in DATASET_KEYS:
            f = os.path.join(path, k + ".npy")
            out[k] = np.load(f, mmap_mode="r" if (mmap and k == "X_seq") else None)
        return out
    return np.load(path)   # .npz fallback (datasetul sintetic de smoke)


def cmd_extract(args):
    log("EXTRACT start (limit=%s, seasons=%s)" % (args.limit, args.seasons))
    if args.seasons:
        seasons = [int(s) for s in args.seasons.split(",") if s.strip()]
    else:
        seasons = list(CONFIG["focus_seasons"])   # implicit: focalizat 2024-2026
    log("focalizare sezoane: %s" % seasons)

    conn = get_conn()
    cur = conn.cursor()
    pool = _fetch_pool(cur, args.limit, seasons)
    n_fix = len(pool)
    log("pool: %d fixture-uri eligibile (fixtures_history ∩ match_events)" % n_fix)
    if not pool:
        log("EROARE: 0 fixture-uri. Verifică fixtures_history/match_events/.env.")
        sys.exit(2)

    seq_cap = CONFIG["seq_cap"]
    n_dyn = len(DYN_FEATURES)
    Ts = list(range(CONFIG["t_min"], CONFIG["t_max"] + 1, CONFIG["minute_stride"]))
    spf = len(Ts)
    total = n_fix * spf      # EXACT: fiecare (fixtur, T) => un eșantion (T>=t_min => L>=1)
    seq_dtype = np.dtype(CONFIG["seq_dtype"])
    log("eșantioane preconizate: %d fix × %d T = %d (pas %d')" % (
        n_fix, spf, total, CONFIG["minute_stride"]))

    out = _ds_dir(args.out)
    os.makedirs(out, exist_ok=True)
    # X_seq = memmap pe disc (NU în RAM): se umple incremental
    X_seq = np.lib.format.open_memmap(
        os.path.join(out, "X_seq.npy"), mode="w+", dtype=seq_dtype,
        shape=(total, seq_cap, n_dyn))
    # restul = arrays mici, în RAM (prealocate la dimensiunea exactă)
    small = {k: np.zeros((total, 3) if k == "baseline" else
                         ((total, len(STATIC_FEATURES)) if k == "X_static" else (total,)),
                         dtype=SMALL_DTYPE[k]) for k in SMALL_DTYPE}

    t0 = time.time()
    w = 0
    for i, meta in enumerate(pool):
        fid = meta["fixture_id"]
        events = _fetch_events(cur, fid)
        states, goals = _build_match_states(meta, events)   # FĂRĂ momentum
        static_vec = (float(meta["home_elo"]), float(meta["away_elo"]),
                      float(meta["elo_diff"]), float(meta["tier"]))
        hid = int(meta["home_team_id"] or 0)
        aid = int(meta["away_team_id"] or 0)
        lid = int(meta["league_id"] or 0)
        ssn = int(meta["season"])
        for T in Ts:
            start = max(0, T - seq_cap)
            seq = states[start:T]
            L = len(seq)                       # >=1 pt T>=t_min
            X_seq[w, :L, :] = np.asarray(seq, dtype=seq_dtype)
            # restul rândului rămâne 0 (memmap proaspăt = zero-filled)
            small["X_len"][w] = L
            small["X_static"][w] = static_vec
            small["home_team_id"][w] = hid
            small["away_team_id"][w] = aid
            small["league_id"][w] = lid
            small["y"][w] = _label_at(goals, T)
            small["baseline"][w] = baseline_distribution(0.0, 0.0, T)  # heuristică fără momentum
            small["season"][w] = ssn
            small["fixture_id"][w] = fid
            small["minute"][w] = T
            w += 1
        if (i + 1) % CONFIG["flush_fixtures"] == 0:
            X_seq.flush()
            log("  %d/%d fixturi · %d/%d eșantioane · %.0fs · [mem %.0fMB]" % (
                i + 1, n_fix, w, total, time.time() - t0, _rss_mb()))

    cur.close()
    conn.close()
    assert w == total, "nepotrivire eșantioane: %d vs %d" % (w, total)
    X_seq.flush()
    del X_seq   # închide memmap-ul

    for k, arr in small.items():
        np.save(os.path.join(out, k + ".npy"), arr)

    dist = np.bincount(small["y"].astype(np.int64), minlength=N_CLASSES)
    seasons_present = sorted(set(int(s) for s in np.unique(small["season"]).tolist()))
    meta_json = {
        "config": CONFIG, "dyn_features": DYN_FEATURES, "static_features": STATIC_FEATURES,
        "n_classes": N_CLASSES, "n_samples": int(total), "n_fixtures": int(n_fix),
        "samples_per_fixture": int(spf), "class_dist": [int(x) for x in dist],
        "seasons_present": seasons_present, "seq_dtype": str(seq_dtype),
        "momentum": False, "created_at": datetime.datetime.now().isoformat(),
        "note": "v1 FĂRĂ momentum (live_stats scos). Encoders+scaler se fit-uiesc la --train.",
    }
    with open(os.path.join(out, "meta.json"), "w") as fh:
        json.dump(meta_json, fh, indent=2, default=str)

    sz = sum(os.path.getsize(os.path.join(out, f)) for f in os.listdir(out)) / (1024 * 1024)
    log("esantioane: %d | clase home/away/none = %d/%d/%d" % (total, dist[0], dist[1], dist[2]))
    log("SCRIS dir %s (%.0f MB total) + meta.json. GATA extract." % (out, sz))


def cmd_merge(args):
    """Concatenează shard-uri (directoare) într-un dataset, STREAMING (X_seq prin memmap)."""
    dirs = [_ds_dir(p) for p in args.inputs]
    metas = [load_dataset(d, mmap=True) for d in dirs]
    sizes = [int(m["y"].shape[0]) for m in metas]
    total = sum(sizes)
    seq0 = metas[0]["X_seq"]
    seq_cap, n_dyn = seq0.shape[1], seq0.shape[2]
    out = _ds_dir(args.out)
    os.makedirs(out, exist_ok=True)
    log("MERGE %d shard-uri -> %d eșantioane total" % (len(dirs), total))

    Xout = np.lib.format.open_memmap(
        os.path.join(out, "X_seq.npy"), mode="w+", dtype=seq0.dtype,
        shape=(total, seq_cap, n_dyn))
    off = 0
    for d, m, n in zip(dirs, metas, sizes):
        src = m["X_seq"]
        for s in range(0, n, 50000):              # copiere în bucăți (RAM mic)
            e = min(s + 50000, n)
            Xout[off + s:off + e] = src[s:e]
        Xout.flush()
        off += n
        log("  + %s (%d) [mem %.0fMB]" % (d, n, _rss_mb()))
    del Xout
    # arrays mici: concatenare în RAM (sunt mici)
    for k in DATASET_KEYS:
        if k == "X_seq":
            continue
        np.save(os.path.join(out, k + ".npy"),
                np.concatenate([np.asarray(m[k]) for m in metas], axis=0))
    # meta combinat
    base_meta = {}
    mp = os.path.join(dirs[0], "meta.json")
    if os.path.exists(mp):
        base_meta = json.load(open(mp))
    base_meta.update({"n_samples": total, "merged_from": dirs,
                      "created_at": datetime.datetime.now().isoformat()})
    json.dump(base_meta, open(os.path.join(out, "meta.json"), "w"), indent=2, default=str)
    log("MERGE -> dir %s (%d eșantioane)" % (out, total))


# ════════════════════════════════════════════════════════════════════════════
#  ENCODERS + SCALER (fit DOAR pe train) — anti-leakage
# ════════════════════════════════════════════════════════════════════════════
def build_encoder(ids_train, min_freq):
    """id brut -> index dens. 0 = UNK (rare/nevăzute). Fit DOAR pe train."""
    vals, counts = np.unique(ids_train, return_counts=True)
    mapping = {}
    nxt = 1
    for v, c in zip(vals.tolist(), counts.tolist()):
        if c >= min_freq:
            mapping[int(v)] = nxt
            nxt += 1
    return mapping, nxt  # nxt = vocab size (inclusiv UNK=0)


def apply_encoder(ids, mapping):
    return np.array([mapping.get(int(v), 0) for v in ids], dtype=np.int64)


def fit_scaler(X_seq_train, X_len_train, X_static_train):
    """
    Standardizare (mean/std). Pt secvențe: doar pașii REALI (mascați după lungime).
    Vectorizat pe BUCĂȚI (chunk) → rapid pe CPU + RAM mărginit. Returnează mean/std.
    """
    N, cap, F = X_seq_train.shape
    ar = np.arange(cap)
    sums = np.zeros(F, dtype=np.float64)
    sqs = np.zeros(F, dtype=np.float64)
    cnt = 0
    for c0 in range(0, N, 100000):
        c1 = min(c0 + 100000, N)
        xb = np.asarray(X_seq_train[c0:c1]).astype(np.float32)
        mb = (ar[None, :] < np.asarray(X_len_train[c0:c1])[:, None])[:, :, None]
        sums += (xb * mb).sum(axis=(0, 1))
        sqs += ((xb * xb) * mb).sum(axis=(0, 1))
        cnt += int(mb.sum())
    mean = sums / max(cnt, 1)
    var = np.maximum(sqs / max(cnt, 1) - mean ** 2, 1e-6)
    dyn_mean, dyn_std = mean.astype(np.float32), np.sqrt(var).astype(np.float32)

    s_mean = X_static_train.mean(axis=0)
    s_std = np.maximum(X_static_train.std(axis=0), 1e-6)
    return {
        "dyn_mean": dyn_mean, "dyn_std": dyn_std,
        "static_mean": s_mean.astype(np.float32), "static_std": s_std.astype(np.float32),
    }


def scale_seq(X_seq, X_len, scaler):
    """Standardizare vectorizată (fp16 disc -> fp32), padding la 0 după lungime."""
    out = np.asarray(X_seq).astype(np.float32)
    dm, ds = scaler["dyn_mean"], scaler["dyn_std"]
    cap = out.shape[1]
    ar = np.arange(cap)
    mask = (ar[None, :] < np.asarray(X_len)[:, None])[:, :, None]   # (N,cap,1)
    out = (out - dm) / ds
    out *= mask        # zero pe pași de padding
    return out


def scale_static(X_static, scaler):
    return (X_static - scaler["static_mean"]) / scaler["static_std"]


# ════════════════════════════════════════════════════════════════════════════
#  SPLIT temporal pe sezon
# ════════════════════════════════════════════════════════════════════════════
def temporal_split(season, y):
    seasons = sorted(set(int(s) for s in season.tolist()))
    if CONFIG["test_seasons"]:
        test_seasons = set(int(s) for s in CONFIG["test_seasons"])
    else:
        # auto: cele mai recente sezoane ce acoperă ~test_frac din esantioane
        counts = {s: int((season == s).sum()) for s in seasons}
        total = len(y)
        test_seasons, acc = set(), 0
        for s in sorted(seasons, reverse=True):
            test_seasons.add(s)
            acc += counts[s]
            if acc >= CONFIG["test_frac"] * total:
                break
    is_test = np.array([int(s) in test_seasons for s in season.tolist()])
    return ~is_test, is_test, sorted(test_seasons)


# ════════════════════════════════════════════════════════════════════════════
#  MODEL (PyTorch)
# ════════════════════════════════════════════════════════════════════════════
def _build_model(n_dyn, n_static, n_team, n_league):
    import torch
    import torch.nn as nn
    from torch.nn.utils.rnn import pack_padded_sequence

    class LiveSeqNet(nn.Module):
        def __init__(self):
            super().__init__()
            c = CONFIG
            self.emb_home = nn.Embedding(n_team, c["emb_team_dim"])
            self.emb_away = nn.Embedding(n_team, c["emb_team_dim"])
            self.emb_lg = nn.Embedding(n_league, c["emb_league_dim"])
            self.gru = nn.GRU(
                input_size=n_dyn, hidden_size=c["gru_hidden"],
                num_layers=c["gru_layers"], batch_first=True,
                dropout=(c["gru_dropout"] if c["gru_layers"] > 1 else 0.0))
            head_in = (c["gru_hidden"] + n_static + 2 * c["emb_team_dim"] + c["emb_league_dim"])
            self.head = nn.Sequential(
                nn.Linear(head_in, c["mlp_hidden"]),
                nn.ReLU(),
                nn.Dropout(c["dropout"]),
                nn.Linear(c["mlp_hidden"], N_CLASSES),
            )

        def forward(self, x_seq, lengths, x_static, hid, aid, lid):
            packed = pack_padded_sequence(
                x_seq, lengths.cpu(), batch_first=True, enforce_sorted=False)
            _, h = self.gru(packed)
            h_last = h[-1]  # [B, hidden]
            cat = torch.cat([
                h_last, x_static,
                self.emb_home(hid), self.emb_away(aid), self.emb_lg(lid)
            ], dim=1)
            return self.head(cat)  # logits

    return LiveSeqNet()


# ════════════════════════════════════════════════════════════════════════════
#  Metrici
# ════════════════════════════════════════════════════════════════════════════
def multiclass_brier(probs, y):
    onehot = np.zeros_like(probs)
    onehot[np.arange(len(y)), y] = 1.0
    return float(np.mean(np.sum((probs - onehot) ** 2, axis=1)))


def binary_brier_goal(probs, y):
    """Colaps gol(0/1) vs niciun gol(2): p_goal = 1 - p_none."""
    p_goal = 1.0 - probs[:, 2]
    y_goal = (y != 2).astype(np.float32)
    return float(np.mean((p_goal - y_goal) ** 2))


def reliability_table(probs, y, bins=10):
    """Reliability pe „p_goal vs gol-real" (binar). Întoarce listă de rânduri text."""
    p_goal = 1.0 - probs[:, 2]
    y_goal = (y != 2).astype(np.float32)
    edges = np.linspace(0, 1, bins + 1)
    rows = []
    for b in range(bins):
        lo, hi = edges[b], edges[b + 1]
        m = (p_goal >= lo) & (p_goal < hi if b < bins - 1 else p_goal <= hi)
        n = int(m.sum())
        if n == 0:
            rows.append((lo, hi, 0, float("nan"), float("nan")))
        else:
            rows.append((lo, hi, n, float(p_goal[m].mean()), float(y_goal[m].mean())))
    return rows


def ece_binary(probs, y, bins=10):
    """Expected Calibration Error pe p_gol (binar)."""
    p = 1.0 - probs[:, 2]
    yb = (y != 2).astype(np.float32)
    edges = np.linspace(0, 1, bins + 1)
    e, N = 0.0, len(y)
    for b in range(bins):
        lo, hi = edges[b], edges[b + 1]
        m = (p >= lo) & (p < hi if b < bins - 1 else p <= hi)
        if m.sum() > 0:
            e += abs(float(p[m].mean()) - float(yb[m].mean())) * int(m.sum()) / N
    return e


# ── BASELINE-uri CORECTE pt setul FĂRĂ momentum ──
def baseline_baserate(y_train, n):
    """(a) base-rate marginal din TRAIN (prag minim — modelul TREBUIE să-l bată)."""
    p = np.bincount(np.asarray(y_train).astype(np.int64), minlength=N_CLASSES).astype(np.float64)
    p = p / max(p.sum(), 1)
    return np.tile(p.astype(np.float32), (n, 1))


def baseline_poisson(hg, ag, minute):
    """
    (b) Poisson CLASIC fără xG, din golurile-de-până-acum + minutul curent (ținta reală).
    Rată din pace observat, cu shrink Bayesian spre un prior de fotbal:
      lam/min = (G + PRIOR_G) / (T + PRIOR_T);  lam_win = lam/min · W ; W=min(10,90-T)
      p_none = e^-lam_win ; p_any = 1-p_none
      share gazdă = (hg + HS·PRIOR_G)/(G + PRIOR_G)  (competing-Poisson => 3 clase)
    """
    pg = CONFIG["poisson_prior_goals"]
    pt = CONFIG["poisson_prior_min"]
    hs = CONFIG["poisson_home_share"]
    hg = np.asarray(hg, dtype=np.float32)
    ag = np.asarray(ag, dtype=np.float32)
    T = np.asarray(minute, dtype=np.float32)
    G = hg + ag
    W = np.minimum(CONFIG["label_window_min"], np.maximum(0.0, 90.0 - T))
    lam_per_min = (G + pg) / (T + pt)
    lam_win = lam_per_min * W
    p_none = np.exp(-lam_win)
    p_any = 1.0 - p_none
    s_h = (hg + hs * pg) / (G + pg)
    return np.stack([p_any * s_h, p_any * (1.0 - s_h), p_none], axis=1).astype(np.float32)


def _goals_at_T(raw_seq, lens):
    """Goluri gazdă/oaspete la T = ultimul pas REAL al secvenței (din X_seq NEscalat)."""
    hi = DYN_FEATURES.index("home_goals")
    ai = DYN_FEATURES.index("away_goals")
    raw = np.asarray(raw_seq)
    N = raw.shape[0]
    hg = np.empty(N, dtype=np.float32)
    ag = np.empty(N, dtype=np.float32)
    for i in range(N):
        j = max(0, int(lens[i]) - 1)
        hg[i] = float(raw[i, j, hi])
        ag[i] = float(raw[i, j, ai])
    return hg, ag


# ════════════════════════════════════════════════════════════════════════════
#  TRAIN / EVAL
# ════════════════════════════════════════════════════════════════════════════
def _stratified_subsample(tr_mask, y, season, target):
    """
    Reduce TRAIN la ~target eșantioane, STRATIFICAT pe (clasă × sezon) ca să NU strice
    distribuția. target = int (nr) sau float în (0,1] (frac). Ordinea (cronologică) se
    păstrează. Testul NU se atinge.
    """
    idx = np.where(tr_mask)[0]
    n = len(idx)
    if target is None:
        return tr_mask
    if 0 < target <= 1.0:
        target = int(round(target * n))
    target = int(target)
    if target >= n:
        log("train-sample %d >= train %d → fără subsample" % (target, n))
        return tr_mask
    rng = np.random.default_rng(CONFIG["seed"])
    groups = {}
    for i in idx:
        groups.setdefault((int(y[i]), int(season[i])), []).append(i)
    keep = []
    for g, members in groups.items():
        k = max(1, int(round(len(members) * target / n)))   # proporțional
        k = min(k, len(members))
        keep.extend(rng.choice(members, size=k, replace=False).tolist())
    new = np.zeros(len(y), dtype=bool)
    new[np.array(sorted(keep))] = True       # sortat => ordine cronologică păstrată
    log("subsample STRATIFICAT (clasă×sezon): TRAIN %d → %d" % (n, int(new.sum())))
    return new


def _prepare(data, smoke=False, train_sample=None):
    """Încarcă dataset (dir/.npz), split temporal, encoders+scaler (fit pe train), tensori."""
    import torch
    d = load_dataset(data, mmap=True)
    X_seq, X_len, X_static = d["X_seq"], np.asarray(d["X_len"]), np.asarray(d["X_static"])
    y, baseline, season = np.asarray(d["y"]), np.asarray(d["baseline"]), np.asarray(d["season"])
    hid_raw = np.asarray(d["home_team_id"]); aid_raw = np.asarray(d["away_team_id"]); lid_raw = np.asarray(d["league_id"])

    tr, te, test_seasons = temporal_split(season, y)
    log("split pe sezon: TRAIN=%d  TEST=%d  (test_seasons=%s)" % (tr.sum(), te.sum(), test_seasons))
    if tr.sum() == 0 or te.sum() == 0:
        log("AVERTISMENT: un split e gol — pe smoke cu puține sezoane e normal. "
            "Cad înapoi pe split 80/20 temporal după fixture order.")
        order = np.argsort(d["fixture_id"])
        cut = int(0.8 * len(order))
        tr = np.zeros(len(y), dtype=bool); te = np.zeros(len(y), dtype=bool)
        tr[order[:cut]] = True; te[order[cut:]] = True

    # subsample STRATIFICAT pe train (testul rămâne ÎNTREG)
    if train_sample is not None:
        tr = _stratified_subsample(tr, y, season, train_sample)

    # encoders DOAR pe train
    team_map, n_team = build_encoder(
        np.concatenate([hid_raw[tr], aid_raw[tr]]), CONFIG["min_team_freq"])
    lg_map, n_league = build_encoder(lid_raw[tr], CONFIG["min_league_freq"])
    log("vocab: echipe=%d (UNK incl), ligi=%d" % (n_team, n_league))

    scaler = fit_scaler(X_seq[tr], X_len[tr], X_static[tr])

    def pack(mask):
        return {
            "X_seq": torch.tensor(scale_seq(X_seq[mask], X_len[mask], scaler)),
            "X_len": torch.tensor(X_len[mask].astype(np.int64)),
            "X_static": torch.tensor(scale_static(X_static[mask], scaler).astype(np.float32)),
            "hid": torch.tensor(apply_encoder(hid_raw[mask], team_map)),
            "aid": torch.tensor(apply_encoder(aid_raw[mask], team_map)),
            "lid": torch.tensor(apply_encoder(lid_raw[mask], lg_map)),
            "y": torch.tensor(y[mask].astype(np.int64)),
            "baseline": np.asarray(baseline[mask]).astype(np.float32),
            "season": season[mask],
        }

    train = pack(tr)
    test = pack(te)

    # baseline-uri CORECTE pe TEST (din date NEscalate): (a) base-rate train, (b) Poisson no-xG
    minute_all = np.asarray(d["minute"])
    raw_test = np.asarray(X_seq[te])                       # NEscalat (fp16) — pt golurile @T
    hg_t, ag_t = _goals_at_T(raw_test, X_len[te])
    test["bl_baserate"] = baseline_baserate(y[tr], int(te.sum()))
    test["bl_poisson"] = baseline_poisson(hg_t, ag_t, minute_all[te])

    enc = {"team_map": team_map, "n_team": n_team, "lg_map": lg_map,
           "n_league": n_league, "scaler": {k: v.tolist() for k, v in scaler.items()}}
    return train, test, enc


def _iter_batches(pack, idx, bs):
    import torch
    idx = torch.as_tensor(np.asarray(idx, dtype=np.int64))
    for i in range(0, len(idx), bs):
        sl = idx[i:i + bs]
        yield {k: pack[k][sl]
               for k in ("X_seq", "X_len", "X_static", "hid", "aid", "lid", "y")}


def _fit_temperature(model, val, device):
    """Temperature scaling: 1 scalar pe validare, minimizează NLL (LBFGS)."""
    import torch
    import torch.nn as nn
    model.eval()
    with torch.no_grad():
        logits = model(val["X_seq"].to(device), val["X_len"].to(device),
                       val["X_static"].to(device), val["hid"].to(device),
                       val["aid"].to(device), val["lid"].to(device)).detach()
        y = val["y"].to(device)
    # Optimizăm în log-spațiu (logT) ca temperatura să rămână STRICT pozitivă —
    # altfel LBFGS poate aluneca în negativ (T<0 inversează softmax-ul).
    logT = torch.nn.Parameter(torch.zeros(1, device=device))  # T = exp(0) = 1
    opt = torch.optim.LBFGS([logT], lr=0.1, max_iter=60)
    nll = nn.CrossEntropyLoss()

    def closure():
        opt.zero_grad()
        loss = nll(logits / torch.exp(logT), y)
        loss.backward()
        return loss
    opt.step(closure)
    T = float(torch.exp(logT.detach()).cpu().item())
    if not math.isfinite(T) or T < 0.05 or T > 20.0:
        return 1.0  # fallback sigur dacă optimizarea a divergeat
    return T


def _predict_probs(model, pack, device, temp=1.0):
    import torch
    model.eval()
    out = []
    with torch.no_grad():
        for i in range(0, len(pack["y"]), 512):
            sl = slice(i, i + 512)
            logits = model(pack["X_seq"][sl].to(device), pack["X_len"][sl].to(device),
                           pack["X_static"][sl].to(device), pack["hid"][sl].to(device),
                           pack["aid"][sl].to(device), pack["lid"][sl].to(device))
            p = torch.softmax(logits / temp, dim=1).cpu().numpy()
            out.append(p)
    return np.concatenate(out, axis=0)


def _train_loop(train, test, enc, epochs, bs, device):
    import torch
    import torch.nn as nn
    torch.manual_seed(CONFIG["seed"])
    np.random.seed(CONFIG["seed"])

    n_dyn = train["X_seq"].shape[2]
    n_static = train["X_static"].shape[1]
    model = _build_model(n_dyn, n_static, enc["n_team"], enc["n_league"]).to(device)

    # validare = ultima felie temporală din train (datele sunt deja în ordine
    # cronologică din extract -> ORDER BY match_date ASC) pt temp scaling
    n = len(train["y"])
    cut = max(1, int((1 - CONFIG["val_frac_time"]) * n))
    tr_idx = np.arange(0, cut)

    opt = torch.optim.Adam(model.parameters(), lr=CONFIG["lr"],
                           weight_decay=CONFIG["weight_decay"])
    crit = nn.CrossEntropyLoss()

    val = {k: train[k][cut:n] for k in
           ("X_seq", "X_len", "X_static", "hid", "aid", "lid", "y")}
    y_val = val["y"].numpy() if hasattr(val["y"], "numpy") else np.asarray(val["y"])
    es_on = CONFIG["early_stopping"] and (n - cut) > 10
    best_brier, best_state, bad = float("inf"), None, 0

    for ep in range(epochs):
        model.train()
        perm = np.random.permutation(tr_idx)
        tot, seen = 0.0, 0
        for batch in _iter_batches(train, perm, bs):
            opt.zero_grad()
            logits = model(batch["X_seq"].to(device), batch["X_len"].to(device),
                           batch["X_static"].to(device), batch["hid"].to(device),
                           batch["aid"].to(device), batch["lid"].to(device))
            loss = crit(logits, batch["y"].to(device))
            loss.backward()
            opt.step()
            tot += float(loss.item()) * len(batch["y"])
            seen += len(batch["y"])
        msg = "epoca %2d/%d  loss=%.4f" % (ep + 1, epochs, tot / max(seen, 1))

        if es_on:
            # EARLY STOPPING pe Brier multiclass val (T=1, înainte de temp scaling)
            vp = _predict_probs(model, val, device, temp=1.0)
            vb = multiclass_brier(vp, y_val)
            msg += "  val_brier=%.5f" % vb
            if vb < best_brier - CONFIG["es_min_delta"]:
                best_brier, bad = vb, 0
                best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            else:
                bad += 1
            log(msg)
            if bad >= CONFIG["es_patience"]:
                log("EARLY STOP (val Brier fără îmbunătățire %d epoci) la epoca %d" % (bad, ep + 1))
                break
        else:
            log(msg)

    if es_on and best_state is not None:
        model.load_state_dict(best_state)   # restaurează cel mai bun model pe val
        log("restaurat best model (val_brier=%.5f)" % best_brier)

    temp = _fit_temperature(model, val, device) if (n - cut) > 10 else 1.0
    log("temperature scaling: T=%.3f" % temp)
    return model, temp


def cmd_train(args, smoke=False):
    import torch
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    # MOD RAPID CPU (--fast): model mic + batch mare + early stopping (corectitudinea
    # rămâne: split temporal, temperature scaling, eval cu baseline-uri NEatinse).
    fast = getattr(args, "fast", False)
    if fast:
        CONFIG["gru_hidden"] = CONFIG["fast_gru_hidden"]
        CONFIG["gru_layers"] = CONFIG["fast_gru_layers"]
        CONFIG["early_stopping"] = True
        log("MOD RAPID: gru_hidden=%d layers=%d early_stopping(patience=%d) epoci<=%d batch=%d" % (
            CONFIG["gru_hidden"], CONFIG["gru_layers"], CONFIG["es_patience"],
            CONFIG["fast_epochs"], CONFIG["fast_batch_size"]))

    # toate core-urile CPU
    if device.type == "cpu":
        nthreads = os.cpu_count() or 1
        torch.set_num_threads(nthreads)
        log("torch.set_num_threads(%d)" % nthreads)

    ts = getattr(args, "train_sample", None)
    train_sample = None
    if ts is not None:
        train_sample = float(ts) if ("." in str(ts) and float(ts) <= 1.0) else int(float(ts))

    log("DEVICE=%s | data=%s | smoke=%s | fast=%s | train_sample=%s" % (
        device, args.data, smoke, fast, train_sample))
    train, test, enc = _prepare(args.data, smoke=smoke, train_sample=train_sample)

    if smoke:
        epochs, bs = CONFIG["smoke_epochs"], CONFIG["smoke_batch_size"]
    elif fast:
        epochs, bs = CONFIG["fast_epochs"], CONFIG["fast_batch_size"]
    else:
        epochs, bs = CONFIG["epochs"], CONFIG["batch_size"]
    model, temp = _train_loop(train, test, enc, epochs, bs, device)

    ckpt = args.ckpt
    torch.save({
        "state_dict": model.state_dict(),
        "temperature": temp,
        "encoders": enc,
        "config": CONFIG,
        "n_dyn": train["X_seq"].shape[2],
        "n_static": train["X_static"].shape[1],
    }, ckpt)
    log("SALVAT checkpoint -> %s (model + temperatura + encoders + scaler)" % ckpt)

    # eval imediat (smoke dovedește cap-coadă)
    _evaluate(model, test, device, temp, report_path=args.report)


def _restore_arch(ck):
    """Aliniază arhitectura globală la cea din checkpoint (ex: --fast a folosit hidden 64)
    ca _build_model să reconstruiască EXACT modelul salvat (altfel load_state_dict pică)."""
    saved = ck.get("config", {}) or {}
    for k in ("gru_hidden", "gru_layers", "gru_dropout", "mlp_hidden",
              "emb_team_dim", "emb_league_dim", "dropout"):
        if k in saved:
            CONFIG[k] = saved[k]


def cmd_eval(args):
    import torch
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    ck = torch.load(args.ckpt, map_location=device, weights_only=False)
    _restore_arch(ck)
    enc = ck["encoders"]

    # reconstruim test split din data + encoders salvate (FĂRĂ re-fit)
    d = load_dataset(args.data, mmap=True)
    X_seq = d["X_seq"]
    X_len, X_static = np.asarray(d["X_len"]), np.asarray(d["X_static"])
    y, baseline, season = np.asarray(d["y"]), np.asarray(d["baseline"]), np.asarray(d["season"])
    hid_raw = np.asarray(d["home_team_id"]); aid_raw = np.asarray(d["away_team_id"]); lid_raw = np.asarray(d["league_id"])
    tr, te, _ = temporal_split(season, y)
    if te.sum() == 0:
        order = np.argsort(np.asarray(d["fixture_id"])); cut = int(0.8 * len(order))
        tr = np.zeros(len(y), dtype=bool); te = np.zeros(len(y), dtype=bool)
        tr[order[:cut]] = True; te[order[cut:]] = True

    scaler = {k: np.array(v, dtype=np.float32) for k, v in enc["scaler"].items()}
    minute_all = np.asarray(d["minute"])
    hg_t, ag_t = _goals_at_T(np.asarray(X_seq[te]), X_len[te])
    pack = {
        "X_seq": torch.tensor(scale_seq(X_seq[te], X_len[te], scaler)),
        "X_len": torch.tensor(X_len[te].astype(np.int64)),
        "X_static": torch.tensor(scale_static(X_static[te], scaler).astype(np.float32)),
        "hid": torch.tensor(apply_encoder(hid_raw[te], {int(k): v for k, v in enc["team_map"].items()})),
        "aid": torch.tensor(apply_encoder(aid_raw[te], {int(k): v for k, v in enc["team_map"].items()})),
        "lid": torch.tensor(apply_encoder(lid_raw[te], {int(k): v for k, v in enc["lg_map"].items()})),
        "y": torch.tensor(y[te].astype(np.int64)),
        "bl_baserate": baseline_baserate(y[tr], int(te.sum())),
        "bl_poisson": baseline_poisson(hg_t, ag_t, minute_all[te]),
    }
    model = _build_model(ck["n_dyn"], ck["n_static"], enc["n_team"], enc["n_league"]).to(device)
    model.load_state_dict(ck["state_dict"])
    _evaluate(model, pack, device, ck.get("temperature", 1.0), report_path=args.report)


def cmd_eval_livesubset(args):
    """
    (c) OPȚIONAL, RULAT PE VPS (are nevoie de DB live_stats): head-to-head MODEL vs
    heuristica REALĂ calcNextGoalWindow(10) cu xG live, DOAR pe sub-setul de test (2026)
    care are snapshot live_stats la/înainte de T. Brier mc+binar pe acel subset.
    """
    import torch
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    ck = torch.load(args.ckpt, map_location=device, weights_only=False)
    _restore_arch(ck)
    enc = ck["encoders"]
    d = load_dataset(args.data, mmap=True)
    X_seq = d["X_seq"]
    X_len, X_static = np.asarray(d["X_len"]), np.asarray(d["X_static"])
    y, season = np.asarray(d["y"]), np.asarray(d["season"])
    fixture, minute = np.asarray(d["fixture_id"]), np.asarray(d["minute"])
    hid_raw = np.asarray(d["home_team_id"]); aid_raw = np.asarray(d["away_team_id"]); lid_raw = np.asarray(d["league_id"])
    _, te, _ = temporal_split(season, y)
    te_idx = np.where(te)[0]
    if len(te_idx) == 0:
        log("test gol — nimic de comparat."); return

    # model probs pe TOT testul
    scaler = {k: np.array(v, dtype=np.float32) for k, v in enc["scaler"].items()}
    pack = {
        "X_seq": torch.tensor(scale_seq(X_seq[te], X_len[te], scaler)),
        "X_len": torch.tensor(X_len[te].astype(np.int64)),
        "X_static": torch.tensor(scale_static(X_static[te], scaler).astype(np.float32)),
        "hid": torch.tensor(apply_encoder(hid_raw[te], {int(k): v for k, v in enc["team_map"].items()})),
        "aid": torch.tensor(apply_encoder(aid_raw[te], {int(k): v for k, v in enc["team_map"].items()})),
        "lid": torch.tensor(apply_encoder(lid_raw[te], {int(k): v for k, v in enc["lg_map"].items()})),
    }
    model = _build_model(ck["n_dyn"], ck["n_static"], enc["n_team"], enc["n_league"]).to(device)
    model.load_state_dict(ck["state_dict"])
    pack["y"] = torch.tensor(y[te].astype(np.int64))
    probs = _predict_probs(model, pack, device, temp=ck.get("temperature", 1.0))

    # live_stats pt fixturile de test
    conn = get_conn(); cur = conn.cursor()
    fids = sorted(set(int(f) for f in fixture[te].tolist()))
    cur.execute("""SELECT fixture_id, elapsed, COALESCE(home_xg,0), COALESCE(away_xg,0)
                     FROM live_stats WHERE fixture_id = ANY(%s) AND elapsed IS NOT NULL
                    ORDER BY fixture_id, elapsed ASC""", (fids,))
    ls = {}
    for fid, e, hx, ax in cur.fetchall():
        ls.setdefault(int(fid), []).append((int(e), float(hx), float(ax)))
    cur.close(); conn.close()

    # subset = eșantioanele de test cu snapshot elapsed<=T; heuristică cu xG REAL
    heur, ysub, mask = [], [], []
    yt = y[te]; ft = fixture[te]; mt = minute[te]
    for k in range(len(te_idx)):
        snaps = ls.get(int(ft[k]))
        if not snaps:
            mask.append(False); continue
        T = int(mt[k]); best = None
        for (e, hx, ax) in snaps:
            if e <= T:
                best = (hx, ax)
            else:
                break
        if best is None:
            mask.append(False); continue
        mask.append(True)
        heur.append(baseline_distribution(best[0], best[1], T))
        ysub.append(int(yt[k]))
    mask = np.array(mask)
    if mask.sum() == 0:
        log("0 eșantioane de test au live_stats — (c) nu se poate calcula."); return
    heur = np.asarray(heur, dtype=np.float32)
    ysub = np.asarray(ysub, dtype=np.int64)
    mprobs = probs[mask]

    lines = ["=" * 72,
             " (c) HEAD-TO-HEAD pe subsetul de test cu live_stats — MODEL vs heuristica reală",
             "=" * 72,
             " subset: %d / %d eșantioane test au snapshot live_stats" % (int(mask.sum()), len(yt)),
             "",
             " %-26s %12s %12s" % ("", "Brier_mc", "Brier_bin"),
             " " + "-" * 50,
             " %-26s %12.5f %12.5f  <= MODEL" % ("GRU live-sequence",
                multiclass_brier(mprobs, ysub), binary_brier_goal(mprobs, ysub)),
             " %-26s %12.5f %12.5f" % ("calcNextGoalWindow(10) [c]",
                multiclass_brier(heur, ysub), binary_brier_goal(heur, ysub)),
             "=" * 72]
    out = "\n".join(lines); print(out)
    if args.report:
        with open(args.report, "w") as fh:
            fh.write(out + "\n")
        log("raport (c) scris -> %s" % args.report)


def _evaluate(model, pack, device, temp, report_path=None):
    probs = _predict_probs(model, pack, device, temp=temp)
    y = pack["y"].numpy() if hasattr(pack["y"], "numpy") else np.asarray(pack["y"])
    dist = np.bincount(y, minlength=N_CLASSES)

    # baseline-uri (atașate în pack de _prepare/cmd_eval). Cheie -> array [N,3].
    baselines = []
    if "bl_baserate" in pack:
        baselines.append(("base-rate (train) [a]", pack["bl_baserate"]))
    if "bl_poisson" in pack:
        baselines.append(("Poisson no-xG [b]", pack["bl_poisson"]))

    bm = multiclass_brier(probs, y)
    bm_bin = binary_brier_goal(probs, y)
    bm_ece = ece_binary(probs, y)

    lines = []
    lines.append("=" * 72)
    lines.append(" EVAL — GRU live-sequence (v1 fără momentum) · test 2026")
    lines.append("=" * 72)
    lines.append(" Esantioane test: %d   | clase home/away/none = %d/%d/%d" % (
        len(y), dist[0], dist[1], dist[2]))
    lines.append(" Temperature scaling: T=%.3f" % temp)
    lines.append("")
    lines.append(" %-26s %12s %12s %10s" % (
        "Model / Baseline", "Brier_mc", "Brier_bin", "ECE_bin"))
    lines.append(" " + "-" * 62)
    lines.append(" %-26s %12.5f %12.5f %10.4f  <= MODEL" % (
        "GRU live-sequence", bm, bm_bin, bm_ece))
    for name, base in baselines:
        lines.append(" %-26s %12.5f %12.5f %10.4f" % (
            name, multiclass_brier(base, y), binary_brier_goal(base, y), ece_binary(base, y)))
    lines.append("")
    for name, base in baselines:
        d_mc = multiclass_brier(base, y) - bm
        lines.append(" Δ Brier_mc vs %-22s = %+.5f  (%s)" % (
            name, d_mc, "model CÂȘTIGĂ" if d_mc > 0 else "model PIERDE/egal"))
    lines.append("")
    lines.append(" RELIABILITY model (p_gol vs frecvență reală gol în 10'):")
    lines.append(" %-14s %10s %12s %12s" % ("bin p_gol", "n", "pred_mediu", "real"))
    for (lo, hi, n, pm, rl) in reliability_table(probs, y):
        if n == 0:
            lines.append(" %4.2f-%4.2f      %10d %12s %12s" % (lo, hi, n, "-", "-"))
        else:
            lines.append(" %4.2f-%4.2f      %10d %12.3f %12.3f" % (lo, hi, n, pm, rl))
    lines.append("=" * 72)
    out = "\n".join(lines)
    print(out)
    if report_path:
        with open(report_path, "w") as fh:
            fh.write(out + "\n")
        log("raport scris -> %s" % report_path)


# ════════════════════════════════════════════════════════════════════════════
#  CLI
# ════════════════════════════════════════════════════════════════════════════
def main():
    ap = argparse.ArgumentParser(description="Experiment GRU live next-goal (10').")
    ap.add_argument("--count", action="store_true", help="doar numărul real (pool backfill), fără dataset/torch")
    ap.add_argument("--extract", action="store_true", help="citește DB, exportă dataset (director .npy)")
    ap.add_argument("--smoke", action="store_true", help="train+eval rapid pe CPU (dovadă)")
    ap.add_argument("--train", action="store_true", help="antrenare completă")
    ap.add_argument("--fast", action="store_true", help="mod rapid CPU (model mic + batch mare + early stopping)")
    ap.add_argument("--train-sample", dest="train_sample", default=None,
                    help="subsample train STRATIFICAT: nr (ex 400000) sau frac (ex 0.4). Testul rămâne întreg.")
    ap.add_argument("--eval", action="store_true", help="evaluare din checkpoint (model vs base-rate + Poisson)")
    ap.add_argument("--eval-livesubset", dest="eval_livesubset", action="store_true",
                    help="(c) VPS: head-to-head vs calcNextGoalWindow(10) pe subsetul cu live_stats")
    ap.add_argument("--merge", action="store_true", help="concatenează shard-uri (directoare)")

    ap.add_argument("--limit", type=int, default=None, help="extract: nr max fixture-uri")
    ap.add_argument("--seasons", type=str, default=None, help="extract: lista sezoane '2024' (implicit focus 2024-2026)")
    ap.add_argument("--out", type=str, default="ml/live_seq", help="extract/merge: DIRECTOR output")
    ap.add_argument("--inputs", nargs="+", default=None, help="merge: directoare shard input (ordine cronologică!)")
    ap.add_argument("--data", type=str, default="ml/live_seq", help="train/eval: dataset (dir sau .npz)")
    ap.add_argument("--ckpt", type=str, default="ml/live_seq.pt", help="checkpoint model")
    ap.add_argument("--report", type=str, default="ml/live_seq_eval.txt", help="raport eval")
    args = ap.parse_args()

    if args.count:
        cmd_count(args)
    elif args.extract:
        cmd_extract(args)
    elif args.merge:
        if not args.inputs:
            ap.error("--merge cere --inputs shard1.npz shard2.npz ...")
        cmd_merge(args)
    elif args.smoke:
        cmd_train(args, smoke=True)
    elif args.train:
        cmd_train(args, smoke=False)
    elif args.eval:
        cmd_eval(args)
    elif args.eval_livesubset:
        cmd_eval_livesubset(args)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
