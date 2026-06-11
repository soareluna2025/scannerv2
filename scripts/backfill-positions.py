"""
backfill-positions.py — construiește fixture_positions (poziție normalizată
ISTORICĂ, point-in-time, ZERO lookahead). FĂRĂ API (API dă doar clasamente
finale = lookahead).

Pentru fiecare (league_id, season) din fixtures_history, parcurge meciurile
CRONOLOGIC, acumulează clasamentul (3p victorie / 1p egal) și salvează poziția
(rank-1)/(teams-1) a ambelor echipe LA MOMENTUL meciului — calculată DOAR din
meciurile anterioare. Echipă fără meci anterior în acel sezon → NULL.

Memory-safe: procesare PER ligă-sezon (un dict mic de puncte + lista meciurilor
acelui sezon). Progres printat per ligă-sezon.

Rulare:  python3 scripts/backfill-positions.py
"""
import os
import psycopg2
from psycopg2.extras import execute_values


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


CREATE_SQL = """
CREATE TABLE IF NOT EXISTS fixture_positions (
    fixture_id         INTEGER PRIMARY KEY,
    home_position_norm REAL,
    away_position_norm REAL,
    computed_at        TIMESTAMPTZ DEFAULT NOW()
);
"""

UPSERT_SQL = """
INSERT INTO fixture_positions (fixture_id, home_position_norm, away_position_norm)
VALUES %s
ON CONFLICT (fixture_id) DO UPDATE SET
  home_position_norm = EXCLUDED.home_position_norm,
  away_position_norm = EXCLUDED.away_position_norm,
  computed_at = NOW()
"""


def rank_of(team, pts, gd, played, teams):
    """Rank 1..N al echipei printre toate echipele ligii (puncte, apoi golaveraj).
    None dacă echipa nu a jucat încă (zero lookahead)."""
    if played.get(team, 0) == 0:
        return None
    order = sorted(teams, key=lambda t: (-pts.get(t, 0), -gd.get(t, 0), t))
    return order.index(team) + 1


def norm(rank, n_teams):
    if rank is None or n_teams <= 1:
        return None
    return round((rank - 1) / (n_teams - 1), 4)


def main():
    conn = get_conn()
    conn.autocommit = False
    cur = conn.cursor()
    cur.execute(CREATE_SQL); conn.commit()

    cur.execute("""
        SELECT DISTINCT league_id, season FROM fixtures_history
         WHERE league_id IS NOT NULL AND season IS NOT NULL
           AND match_date >= '2023-01-01'
         ORDER BY league_id, season
    """)
    ls_pairs = cur.fetchall()
    print(f"Ligă-sezon de procesat: {len(ls_pairs)}")

    total_rows = 0
    for idx, (lg, season) in enumerate(ls_pairs, 1):
        cur.execute("""
            SELECT fixture_id, home_team_id, away_team_id, home_goals, away_goals
              FROM fixtures_history
             WHERE league_id=%s AND season=%s AND status_short='FT'
               AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL
               AND home_goals IS NOT NULL AND away_goals IS NOT NULL
             ORDER BY match_date ASC, fixture_id ASC
        """, (lg, season))
        matches = cur.fetchall()
        if not matches:
            continue
        teams = set()
        for _, h, a, _, _ in matches:
            teams.add(h); teams.add(a)
        pts, gd, played = {}, {}, {}
        out = []
        for fid, h, a, hg, ag in matches:
            n_teams = len(teams)
            hn = norm(rank_of(h, pts, gd, played, teams), n_teams)
            an = norm(rank_of(a, pts, gd, played, teams), n_teams)
            out.append((int(fid), hn, an))
            # aplică rezultatul DUPĂ ce am salvat poziția (point-in-time)
            played[h] = played.get(h, 0) + 1
            played[a] = played.get(a, 0) + 1
            gd[h] = gd.get(h, 0) + (hg - ag)
            gd[a] = gd.get(a, 0) + (ag - hg)
            if hg > ag:   pts[h] = pts.get(h, 0) + 3
            elif ag > hg: pts[a] = pts.get(a, 0) + 3
            else:
                pts[h] = pts.get(h, 0) + 1
                pts[a] = pts.get(a, 0) + 1
        execute_values(cur, UPSERT_SQL, out, page_size=1000)
        conn.commit()
        total_rows += len(out)
        if idx % 50 == 0 or idx == len(ls_pairs):
            print(f"  [{idx}/{len(ls_pairs)}] lg={lg} season={season} "
                  f"meciuri={len(out)} | total scris={total_rows}")
    print(f"✅ fixture_positions complet: {total_rows} rânduri.")
    cur.execute("ANALYZE fixture_positions"); conn.commit()
    print("ANALYZE fixture_positions ✓")
    cur.close(); conn.close()


if __name__ == "__main__":
    main()
