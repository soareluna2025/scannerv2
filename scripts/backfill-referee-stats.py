"""
backfill-referee-stats.py — reconstruiește referee_stats din TOT istoricul
(fixtures_history + match_stats), ZERO API.

Normalizare nume pentru MERGE variante: lower(trim(split_part(referee, ',', 1)))
(taie sufixul gen ", England"). Agregarea se face per cheie normalizată, dar
UPSERT-ul scrie UN RÂND PER NUME RAW din grup → join-ul existent exact
(referee_stats.referee_name = fixtures_history.referee) rămâne funcțional ȘI
variantele aceluiași arbitru împart aceleași statistici. Prag minim 10 meciuri.

Memory-safe: agregarea (milioane de rânduri) se face SERVER-SIDE; Python primește
doar grupurile (mii). referee_style EXACT ca api/cron/referee-stats.js.

Rulare:  python3 scripts/backfill-referee-stats.py
"""
import os
import psycopg2
from psycopg2.extras import execute_batch


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


# Agregare per cheie normalizată (SQL = sursa de adevăr; mirror referee-stats.js).
AGG_SQL = """
WITH base AS (
  SELECT fh.fixture_id,
         lower(btrim(split_part(fh.referee, ',', 1))) AS rkey,
         fh.referee AS raw,
         fh.home_goals, fh.away_goals
  FROM fixtures_history fh
  WHERE fh.referee IS NOT NULL AND btrim(fh.referee) <> ''
    AND fh.status_short = 'FT'
    AND fh.home_goals IS NOT NULL AND fh.away_goals IS NOT NULL
),
cards AS (
  SELECT ms.fixture_id,
         SUM(COALESCE(ms.yellow_cards,0)) AS yc,
         SUM(COALESCE(ms.red_cards,0))    AS rc,
         SUM(COALESCE(ms.corner_kicks,0)) AS corners,
         SUM(COALESCE(ms.fouls,0))        AS fouls,
         COUNT(*)                          AS teams_with_stats
  FROM match_stats ms GROUP BY ms.fixture_id
)
SELECT b.rkey,
       array_agg(DISTINCT b.raw)                                           AS raws,
       COUNT(*)                                                            AS n_matches,
       AVG(b.home_goals + b.away_goals)                                    AS avg_goals,
       100.0*COUNT(*) FILTER (WHERE b.home_goals+b.away_goals>=3)/COUNT(*) AS pct_over25,
       100.0*COUNT(*) FILTER (WHERE b.home_goals>0 AND b.away_goals>0)/COUNT(*) AS pct_gg,
       AVG(c.yc)      FILTER (WHERE c.teams_with_stats >= 2)               AS avg_yellow,
       AVG(c.rc)      FILTER (WHERE c.teams_with_stats >= 2)               AS avg_red,
       AVG(c.corners) FILTER (WHERE c.teams_with_stats >= 2)               AS avg_corners,
       AVG(c.fouls)   FILTER (WHERE c.teams_with_stats >= 2)               AS avg_fouls
FROM base b
LEFT JOIN cards c ON c.fixture_id = b.fixture_id
GROUP BY b.rkey
HAVING COUNT(*) >= 10
"""

UPSERT_SQL = """
INSERT INTO referee_stats
  (referee_name, total_matches, avg_yellow_cards, avg_red_cards, avg_penalties,
   avg_fouls, avg_corners, avg_goals, pct_over_25, pct_gg, pct_btts,
   referee_style, updated_at)
VALUES (%s,%s,%s,%s,0,%s,%s,%s,%s,%s,%s,%s,NOW())
ON CONFLICT (referee_name) DO UPDATE SET
  total_matches=EXCLUDED.total_matches, avg_yellow_cards=EXCLUDED.avg_yellow_cards,
  avg_red_cards=EXCLUDED.avg_red_cards, avg_fouls=EXCLUDED.avg_fouls,
  avg_corners=EXCLUDED.avg_corners, avg_goals=EXCLUDED.avg_goals,
  pct_over_25=EXCLUDED.pct_over_25, pct_gg=EXCLUDED.pct_gg, pct_btts=EXCLUDED.pct_btts,
  referee_style=EXCLUDED.referee_style, updated_at=NOW()
"""


def style(avg_yellow, avg_goals):
    # EXACT ca api/cron/referee-stats.js
    if avg_yellow is not None and avg_yellow >= 5.0: return "strict"
    if avg_yellow is not None and avg_yellow <= 2.5: return "lenient"
    if avg_goals is not None and avg_goals >= 3.0:   return "open"
    if avg_goals is not None and avg_goals <= 1.8:   return "closed"
    return "neutral"


def f(x):
    return None if x is None else float(x)


def main():
    conn = get_conn()
    conn.autocommit = False
    cur = conn.cursor()
    print("Agregare referee_stats din tot istoricul (server-side)...")
    cur.execute(AGG_SQL)
    rows = cur.fetchall()
    print(f"Grupuri (arbitri normalizați >= 10 meciuri): {len(rows)}")

    params = []
    for (rkey, raws, n_matches, avg_goals, pct_over25, pct_gg,
         avg_yellow, avg_red, avg_corners, avg_fouls) in rows:
        ay = f(avg_yellow); ag = f(avg_goals)
        st = style(ay, ag)
        for raw in raws:                      # un rând per nume RAW → join exact merge
            params.append((
                raw, int(n_matches),
                round(ay, 2) if ay is not None else 0,
                round(f(avg_red), 2) if avg_red is not None else 0,
                round(f(avg_fouls), 2) if avg_fouls is not None else 0,
                round(f(avg_corners), 2) if avg_corners is not None else 0,
                round(ag, 2) if ag is not None else 0,
                round(f(pct_over25), 2) if pct_over25 is not None else 0,
                round(f(pct_gg), 2) if pct_gg is not None else 0,
                round(f(pct_gg), 2) if pct_gg is not None else 0,   # pct_btts = pct_gg
                st,
            ))

    print(f"UPSERT {len(params)} rânduri (nume raw)...")
    done = 0
    for i in range(0, len(params), 5000):
        execute_batch(cur, UPSERT_SQL, params[i:i + 5000], page_size=1000)
        conn.commit()
        done += len(params[i:i + 5000])
        if done % 10000 < 5000:
            print(f"  ... {done}/{len(params)} upsert")
    print(f"✅ referee_stats backfill complet: {done} rânduri raw din {len(rows)} arbitri.")
    cur.close(); conn.close()


if __name__ == "__main__":
    main()
