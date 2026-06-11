"""
backfill-ml-features.py — populează ml_features pentru fixturile din fereastra de
antrenare (fixtures_history >= 2023) care NU au încă rând. ZERO API.

Refolosește EXACT cele 4 LATERAL-uri (msh/msa/meh/mea, rolling 100 meciuri ÎNAINTE
de data meciului) din api/cron/build-ml-features.js — SINGURA diferență: sursa de
fixturi e fixtures_history (nu doar `predictions`), fiindcă multe fixturi istorice
n-au rând în predictions și de aceea rămâneau fără ml_features.

Chunked (BATCH fixturi/lot), reluabil (ON CONFLICT DO NOTHING + NOT EXISTS),
progres printat. Memory-safe: tot calculul e SERVER-SIDE; Python doar buclează.

Rulare:  python3 scripts/backfill-ml-features.py [--batch 5000] [--since 2023]
"""
import os
import sys
import time
import psycopg2


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


# IDENTIC cu INSERT_SQL din api/cron/build-ml-features.js, DOAR subquery-ul sursă
# schimbat: din fixtures_history (fără ml_features) în loc de predictions.
INSERT_SQL = """
INSERT INTO ml_features (
  fixture_id,
  home_sot_avg, away_sot_avg,
  home_corners_avg, away_corners_avg,
  home_xg_avg, away_xg_avg,
  home_yc_avg, away_yc_avg,
  home_rc_avg, away_rc_avg,
  home_fouls_avg, away_fouls_avg,
  home_insidebox_avg, away_insidebox_avg,
  home_possession_avg, away_possession_avg,
  home_goals_r1_avg, away_goals_r1_avg,
  home_goals_r2_avg, away_goals_r2_avg,
  home_subs_avg, away_subs_avg
)
SELECT
  p.fixture_id,
  msh.sot_avg, msa.sot_avg,
  msh.corners_avg, msa.corners_avg,
  msh.xg_avg, msa.xg_avg,
  msh.yc_avg, msa.yc_avg,
  msh.rc_avg, msa.rc_avg,
  msh.fouls_avg, msa.fouls_avg,
  msh.insidebox_avg, msa.insidebox_avg,
  msh.possession_avg, msa.possession_avg,
  meh.goals_r1_avg, mea.goals_r1_avg,
  meh.goals_r2_avg, mea.goals_r2_avg,
  meh.subs_avg, mea.subs_avg
FROM (
  SELECT fh2.fixture_id, fh2.match_date
    FROM fixtures_history fh2
   WHERE fh2.match_date >= %s
     AND fh2.home_team_id IS NOT NULL AND fh2.away_team_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM ml_features mf WHERE mf.fixture_id = fh2.fixture_id)
   ORDER BY fh2.match_date DESC
   LIMIT %s
) p
JOIN fixtures_history fh ON fh.fixture_id = p.fixture_id
LEFT JOIN LATERAL (
    SELECT AVG(ms.shots_on_goal) AS sot_avg, AVG(ms.corner_kicks) AS corners_avg,
           AVG(ms.expected_goals) AS xg_avg, AVG(ms.yellow_cards) AS yc_avg,
           AVG(ms.red_cards) AS rc_avg, AVG(ms.fouls) AS fouls_avg,
           AVG(ms.shots_insidebox) AS insidebox_avg, AVG(ms.ball_possession) AS possession_avg
    FROM (
        SELECT ms.* FROM match_stats ms
        JOIN fixtures_history fhx ON fhx.fixture_id = ms.fixture_id
        WHERE ms.team_id = fh.home_team_id AND fhx.match_date < fh.match_date
        ORDER BY fhx.match_date DESC LIMIT 100
    ) ms
) msh ON true
LEFT JOIN LATERAL (
    SELECT AVG(ms.shots_on_goal) AS sot_avg, AVG(ms.corner_kicks) AS corners_avg,
           AVG(ms.expected_goals) AS xg_avg, AVG(ms.yellow_cards) AS yc_avg,
           AVG(ms.red_cards) AS rc_avg, AVG(ms.fouls) AS fouls_avg,
           AVG(ms.shots_insidebox) AS insidebox_avg, AVG(ms.ball_possession) AS possession_avg
    FROM (
        SELECT ms.* FROM match_stats ms
        JOIN fixtures_history fhx ON fhx.fixture_id = ms.fixture_id
        WHERE ms.team_id = fh.away_team_id AND fhx.match_date < fh.match_date
        ORDER BY fhx.match_date DESC LIMIT 100
    ) ms
) msa ON true
LEFT JOIN LATERAL (
    SELECT
        AVG(CASE WHEN g.r1_goals IS NOT NULL THEN g.r1_goals ELSE 0 END) AS goals_r1_avg,
        AVG(CASE WHEN g.r2_goals IS NOT NULL THEN g.r2_goals ELSE 0 END) AS goals_r2_avg,
        AVG(g.subs) AS subs_avg
    FROM (
        SELECT fhx.fixture_id,
            SUM(CASE WHEN me.type='Goal' AND me.elapsed<=45 AND me.team_id=fh.home_team_id THEN 1 ELSE 0 END) AS r1_goals,
            SUM(CASE WHEN me.type='Goal' AND me.elapsed>45 AND me.team_id=fh.home_team_id THEN 1 ELSE 0 END) AS r2_goals,
            SUM(CASE WHEN me.type='subst' AND me.team_id=fh.home_team_id THEN 1 ELSE 0 END) AS subs
        FROM fixtures_history fhx
        JOIN match_events me ON me.fixture_id=fhx.fixture_id
        WHERE (fhx.home_team_id=fh.home_team_id OR fhx.away_team_id=fh.home_team_id)
        AND fhx.match_date < fh.match_date
        GROUP BY fhx.fixture_id
        ORDER BY MAX(fhx.match_date) DESC LIMIT 100
    ) g
) meh ON true
LEFT JOIN LATERAL (
    SELECT
        AVG(CASE WHEN g.r1_goals IS NOT NULL THEN g.r1_goals ELSE 0 END) AS goals_r1_avg,
        AVG(CASE WHEN g.r2_goals IS NOT NULL THEN g.r2_goals ELSE 0 END) AS goals_r2_avg,
        AVG(g.subs) AS subs_avg
    FROM (
        SELECT fhx.fixture_id,
            SUM(CASE WHEN me.type='Goal' AND me.elapsed<=45 AND me.team_id=fh.away_team_id THEN 1 ELSE 0 END) AS r1_goals,
            SUM(CASE WHEN me.type='Goal' AND me.elapsed>45 AND me.team_id=fh.away_team_id THEN 1 ELSE 0 END) AS r2_goals,
            SUM(CASE WHEN me.type='subst' AND me.team_id=fh.away_team_id THEN 1 ELSE 0 END) AS subs
        FROM fixtures_history fhx
        JOIN match_events me ON me.fixture_id=fhx.fixture_id
        WHERE (fhx.home_team_id=fh.away_team_id OR fhx.away_team_id=fh.away_team_id)
        AND fhx.match_date < fh.match_date
        GROUP BY fhx.fixture_id
        ORDER BY MAX(fhx.match_date) DESC LIMIT 100
    ) g
) mea ON true
ON CONFLICT (fixture_id) DO NOTHING
"""

REMAINING_SQL = """
SELECT COUNT(*) FROM fixtures_history fh2
 WHERE fh2.match_date >= %s
   AND fh2.home_team_id IS NOT NULL AND fh2.away_team_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM ml_features mf WHERE mf.fixture_id = fh2.fixture_id)
"""


def arg(name, default):
    if name in sys.argv:
        return sys.argv[sys.argv.index(name) + 1]
    return default


def main():
    batch = int(arg("--batch", "5000"))
    since = f"{arg('--since', '2023')}-01-01"
    conn = get_conn(); conn.autocommit = False
    cur = conn.cursor()
    cur.execute(REMAINING_SQL, (since,))
    remaining = cur.fetchone()[0]
    print(f"De procesat (fixturi {since}+ fără ml_features): {remaining}  batch={batch}")

    total = 0
    while True:
        t0 = time.time()
        cur.execute(INSERT_SQL, (since, batch))
        ins = cur.rowcount or 0
        conn.commit()
        total += ins
        print(f"  inserate={ins}  total={total}  ({time.time()-t0:.1f}s)")
        if ins == 0:
            break
    cur.execute(REMAINING_SQL, (since,))
    rem = cur.fetchone()[0]
    print(f"✅ ml_features backfill complet: +{total} rânduri. Rămase (fără stats sursă): {rem}")
    cur.execute("ANALYZE ml_features"); conn.commit()
    print("ANALYZE ml_features ✓")
    cur.close(); conn.close()


if __name__ == "__main__":
    main()
