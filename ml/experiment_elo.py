"""
experiment_elo.py — tunare PARAMETRI ELO pe istoric, out-of-sample (READ-ONLY).
NU atinge build-elo.js / producția. Doar rejoacă ELO pe o grilă și raportează.

Metodă:
  • Extrage parametrii ACTUALI de producție din api/cron/build-elo.js (baseline).
  • Încarcă toate meciurile FT din fixtures_history cronologic (exclude amicale lg=10).
  • Rejoacă ELO de la 1500 (per team_id+league_id, ca producția) pe grila
    K × avantaj_teren + combinația de PRODUCȚIE (K variabil + decay + greutate ligă).
  • SPLIT TEMPORAL: meciuri < 2025-07 = warm-up; evaluare DOAR pe 2025-07 → azi.
  • Metrici: Brier pe scorul așteptat (E vs 1/0.5/0) + acuratețe câștigător (fără egaluri).
  • Raport: ml/elo_experiment_report.txt (sortat după Brier, baseline marcat).

Memorie (VPS 2GB): meciurile o singură dată în memorie (tuple), replay secvențial
per combinație (un dict de rating-uri la un moment dat). Progres la 50k meciuri.

Rulare:  python3 ml/experiment_elo.py
"""
import os
import re
import math
import datetime
import psycopg2

ML_DIR = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(ML_DIR)
REPORT = os.path.join(ML_DIR, "elo_experiment_report.txt")

EVAL_FROM = datetime.datetime(2025, 7, 1, tzinfo=datetime.timezone.utc)
K_LIST    = [10, 16, 20, 24, 32, 40]
HADV_LIST = [0, 50, 75, 100]
DIVISOR   = 400.0
START     = 1500.0


def _load_env(path="/root/scannerv2/.env"):
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k = k.strip(); v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except FileNotFoundError:
        pass


def get_conn():
    _load_env()
    url = os.getenv("POSTGRES_URL")
    if url:
        return psycopg2.connect(url)
    return psycopg2.connect(
        dbname=os.getenv("PGDATABASE", "elefant"), user=os.getenv("PGUSER", "alohascan"),
        password=os.getenv("PGPASSWORD"), host=os.getenv("PGHOST", "127.0.0.1"),
        port=os.getenv("PGPORT", "5432"))


# ── Replică EXACTĂ a logicii de producție (din build-elo.js) ──────────────────
def k_factor(games):              # kFactor(games): <10→40, <30→32, else 24
    return 40 if games < 10 else 32 if games < 30 else 24

_W15 = set([2, 3, 848, 1, 5, 6, 29, 30, 31, 32, 33, 34])
_W13 = set([39, 140, 135, 78, 61, 88, 94, 203, 207, 197, 13, 11])
_W08 = set([45, 143, 137, 81, 65])
_W09 = set([40, 141, 136, 79, 62])
def comp_weight(lid):
    if lid in _W15: return 1.5
    if lid in _W13: return 1.3
    if lid in _W08: return 0.8
    if lid in _W09: return 0.9
    if lid == 10:   return 0.5
    return 1.0
PHI = 0.03   # temporal decay/lună


def extract_prod_params():
    """Citește build-elo.js și raportează parametrii de producție (pt baseline)."""
    p = {}
    try:
        s = open(os.path.join(REPO, "api", "cron", "build-elo.js")).read()
        p["kFactor"] = (re.search(r"function kFactor[^\n]*\n?[^}]*", s) or [None])
        p["divisor"] = re.search(r"Math\.pow\(10,[^/]*/\s*(\d+)\)", s)
        p["start"]   = "1500" if "1500" in s else "?"
        p["phi"]     = re.search(r"-?0?\.0?3\s*\*\s*Math\.max", s) or re.search(r"exp\(-(0\.\d+)", s)
        p["home_adv"]= 0  # build-elo NU adaugă avantaj de teren în expected
    except Exception:
        pass
    return p


def load_matches(conn):
    cur = conn.cursor("elo_stream")   # cursor server-side (memorie mică la fetch)
    cur.itersize = 20000
    cur.execute("""
        SELECT home_team_id, away_team_id, league_id, home_goals, away_goals, match_date
          FROM fixtures_history
         WHERE status_short IN ('FT','AET','PEN')
           AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL
           AND home_goals IS NOT NULL  AND away_goals IS NOT NULL
           AND league_id IS NOT NULL AND league_id <> 10   -- exclude amicale
         ORDER BY match_date ASC NULLS LAST, fixture_id ASC
    """)
    rows = []
    now_ts = datetime.datetime.now(datetime.timezone.utc)
    for r in cur:
        hid, aid, lid, hg, ag, md = r
        actH = 1.0 if hg > ag else (0.5 if hg == ag else 0.0)
        # months_ago pt decay (folosit doar de producție)
        months = 0.0
        is_eval = False
        if md is not None:
            if md.tzinfo is None:
                md = md.replace(tzinfo=datetime.timezone.utc)
            months = max(0.0, (now_ts - md).total_seconds() / (86400 * 30))
            is_eval = md >= EVAL_FROM
        rows.append((int(hid), int(aid), int(lid), actH, months, is_eval))
        if len(rows) % 50000 == 0:
            print(f"  ... încărcate {len(rows)} meciuri")
    cur.close()
    print(f"Total meciuri FT încărcate: {len(rows)}")
    return rows


def expected(preH, preA, hadv):
    return 1.0 / (1.0 + 10 ** ((preA - (preH + hadv)) / DIVISOR))


def replay(matches, mode, K=None, hadv=0):
    """mode='grid' (K const + hadv) sau 'prod' (kFactor×weight×decay, hadv=0).
    Întoarce (brier, accuracy, n_eval, n_eval_nondraw)."""
    elo = {}   # (team,league) → [rating, games]
    se = 0.0; n_eval = 0
    acc_ok = 0; acc_tot = 0
    for hid, aid, lid, actH, months, is_eval in matches:
        kh = (hid, lid); ka = (aid, lid)
        H = elo.get(kh)
        if H is None: H = [START, 0]; elo[kh] = H
        A = elo.get(ka)
        if A is None: A = [START, 0]; elo[ka] = A
        preH, preA = H[0], A[0]
        # Avantajul de teren intră în expected pentru AMBELE moduri: prod cu hadv=0
        # → identic cu producția reală; prod cu hadv>0 → confirmarea avantajului
        # PE logica completă de producție (K dinamic + decay + comp_weight neatinse).
        expH = expected(preH, preA, hadv)
        # evaluare DOAR pe fereastra out-of-sample
        if is_eval:
            se += (expH - actH) ** 2
            n_eval += 1
            if actH != 0.5:
                acc_tot += 1
                pred_home = expH > 0.5
                if (pred_home and actH == 1.0) or ((not pred_home) and actH == 0.0):
                    acc_ok += 1
        # update (după snapshot)
        if mode == "prod":
            w = comp_weight(lid); dec = math.exp(-PHI * months)
            kH = k_factor(H[1]) * w * dec
            kA = k_factor(A[1]) * w * dec
        else:
            kH = kA = K
        H[0] = preH + kH * (actH - expH)
        A[0] = preA + kA * ((1 - actH) - (1 - expH))
        H[1] += 1; A[1] += 1
    brier = (se / n_eval) if n_eval else float("nan")
    acc = (100.0 * acc_ok / acc_tot) if acc_tot else float("nan")
    return brier, acc, n_eval, acc_tot


def main():
    print("EXPERIMENT ELO — tunare parametri (read-only)\n")
    pp = extract_prod_params()
    print("Parametri PRODUCȚIE (din build-elo.js): start=1500, divisor=400, "
          "home_adv=0, K=kFactor(games){40/32/24}, ×comp_weight, ×decay(phi=0.03/lună)\n")

    conn = get_conn()
    matches = load_matches(conn)
    conn.close()
    n_total = len(matches)
    n_eval = sum(1 for m in matches if m[5])
    print(f"Fereastră EVALUARE (>= {EVAL_FROM.date()}): {n_eval} meciuri\n")
    if n_eval == 0:
        print("⚠ Niciun meci în fereastra de evaluare — abort.")
        return

    results = []  # (label, brier, acc, n_eval, is_baseline)

    # Baseline producție
    print("Replay PRODUCȚIE (baseline)...")
    b, a, ne, nd = replay(matches, "prod")
    results.append(("PRODUCȚIE (K var+decay+weight, hadv=0)", b, a, ne, True))

    # Grilă ELO standard (K const + avantaj teren)
    for K in K_LIST:
        for hadv in HADV_LIST:
            b, a, ne, nd = replay(matches, "grid", K=K, hadv=hadv)
            results.append((f"K={K:<2} hadv={hadv:<3}", b, a, ne, False))
            print(f"  K={K} hadv={hadv}: Brier={b:.4f} acc={a:.1f}%")

    # PRODUCȚIE COMPLETĂ + avantaj de teren — confirmă dacă hadv ajută PE logica reală
    # (K dinamic + decay + comp_weight identice cu baseline-ul, doar expected primește hadv).
    print("Replay PRODUCȚIE + avantaj teren (logica completă)...")
    for hadv in (25, 50, 75, 100):
        b, a, ne, nd = replay(matches, "prod", hadv=hadv)
        results.append((f"P+hadv={hadv:<3} (K var+decay+weight)", b, a, ne, False))
        print(f"  P+hadv={hadv}: Brier={b:.4f} acc={a:.1f}%")

    results.sort(key=lambda r: (float("inf") if r[1] != r[1] else r[1]))
    base = next((r for r in results if r[4]), None)
    best = results[0]

    lines = []
    lines.append(f"EXPERIMENT ELO — {datetime.datetime.now():%Y-%m-%d %H:%M:%S}")
    lines.append(f"Meciuri total={n_total}  ·  fereastră evaluare (>= {EVAL_FROM.date()})={n_eval}")
    lines.append("Sortat după Brier (mai mic = mai bun). 'B' = baseline producție.")
    lines.append("")
    lines.append(f"{'':2} {'combinație':40} {'Brier':>8} {'Acc%':>7} {'N_eval':>8}")
    for lbl, b, a, ne, isb in results:
        tag = "B " if isb else ("★ " if (lbl == best[0]) else "  ")
        lines.append(f"{tag}{lbl:40} {b:8.4f} {a:7.1f} {ne:8d}")
    lines.append("")
    if base:
        d_b = base[1] - best[1]
        lines.append(f"BASELINE producție: Brier={base[1]:.4f}  Acc={base[2]:.1f}%")
        lines.append(f"CEL MAI BUN: {best[0]}  Brier={best[1]:.4f}  Acc={best[2]:.1f}%")
        lines.append(f"DELTA (baseline − best): {d_b:+.4f} Brier "
                     f"({'îmbunătățire' if d_b > 0 else 'fără câștig'})")
    lines.append("")
    lines.append("Notă: 'K=.. hadv=..' = ELO standard (K const + avantaj teren, fără decay/greutăți).")
    lines.append("'B' = baseline producție (K dinamic + decay + comp_weight, hadv=0).")
    lines.append("'P+hadv=X' = logica COMPLETĂ de producție + avantaj de teren X (confirmă dacă")
    lines.append("hadv ajută pe modelul real). Niciun cod de producție atins (build-elo.js neatins).")

    out = "\n".join(lines)
    print("\n" + out)
    with open(REPORT, "w") as f:
        f.write(out + "\n")
    print(f"\n✅ Raport: {REPORT}")


if __name__ == "__main__":
    main()
