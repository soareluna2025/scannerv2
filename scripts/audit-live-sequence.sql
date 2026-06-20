-- ════════════════════════════════════════════════════════════════════════════
-- audit-live-sequence.sql  —  AUDIT READ-ONLY (NU repară nimic, NU scrie nimic)
-- Pt experimentul experiment_live_sequence.py: de ce pică pool-ul de eligibilitate
-- (764 → 27) și cât rămâne fără cerința live_stats.
--
-- Rulare pe VPS (o singură linie):
--   cd /root/scannerv2 && set -a && . ./.env && set +a && psql "$POSTGRES_URL" -f scripts/audit-live-sequence.sql
-- ════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP off
\pset pager off
\timing off

\echo ''
\echo '##############################################################'
\echo '# 1) INVENTAR  (rows / distinct fixture_id / season+date span)'
\echo '##############################################################'
-- Tabele cu fixture_id: rows, distinct fixtures, span sezon/dată (join la fixtures).
SELECT 'match_events'    AS tbl, count(*) AS rows, count(DISTINCT t.fixture_id) AS fix,
       min(f.season) AS s_min, max(f.season) AS s_max,
       min(f.match_date)::date AS d_min, max(f.match_date)::date AS d_max
  FROM match_events t LEFT JOIN fixtures f ON f.fixture_id = t.fixture_id
UNION ALL SELECT 'live_stats', count(*), count(DISTINCT t.fixture_id),
       min(f.season), max(f.season), min(f.match_date)::date, max(f.match_date)::date
  FROM live_stats t LEFT JOIN fixtures f ON f.fixture_id = t.fixture_id
UNION ALL SELECT 'elo_history', count(*), count(DISTINCT t.fixture_id),
       min(f.season), max(f.season), min(f.match_date)::date, max(f.match_date)::date
  FROM elo_history t LEFT JOIN fixtures f ON f.fixture_id = t.fixture_id
UNION ALL SELECT 'elo_applied', count(*), count(DISTINCT t.fixture_id),
       min(f.season), max(f.season), min(f.match_date)::date, max(f.match_date)::date
  FROM elo_applied t LEFT JOIN fixtures f ON f.fixture_id = t.fixture_id
UNION ALL SELECT 'fixtures', count(*), count(DISTINCT t.fixture_id),
       min(t.season), max(t.season), min(t.match_date)::date, max(t.match_date)::date
  FROM fixtures t
UNION ALL SELECT 'fixtures_history', count(*), count(DISTINCT t.fixture_id),
       min(t.season), max(t.season), min(t.match_date)::date, max(t.match_date)::date
  FROM fixtures_history t
UNION ALL SELECT 'match_stats', count(*), count(DISTINCT t.fixture_id),
       min(f.season), max(f.season), min(f.match_date)::date, max(f.match_date)::date
  FROM match_stats t LEFT JOIN fixtures f ON f.fixture_id = t.fixture_id
UNION ALL SELECT 'match_snapshots', count(*), count(DISTINCT t.fixture_id),
       min(f.season), max(f.season), min(f.match_date)::date, max(f.match_date)::date
  FROM match_snapshots t LEFT JOIN fixtures f ON f.fixture_id = t.fixture_id
UNION ALL SELECT 'prematch_data', count(*), count(DISTINCT t.fixture_id),
       min(f.season), max(f.season), min(f.match_date)::date, max(f.match_date)::date
  FROM prematch_data t LEFT JOIN fixtures f ON f.fixture_id = t.fixture_id
ORDER BY tbl;

\echo ''
\echo '-- leagues (fără fixture_id): rows / distinct league_id / span tier'
SELECT count(*) AS rows, count(DISTINCT league_id) AS leagues,
       min(tier) AS tier_min, max(tier) AS tier_max,
       count(*) FILTER (WHERE league_id = 10) AS league10_rows
  FROM leagues;

\echo ''
\echo '##############################################################'
\echo '# 2) FUNNEL eligibilitate  (cumulativ; unde se prăbușește 764→27)'
\echo '##############################################################'
-- Fiecare etapă ADAUGĂ o condiție peste precedenta. „finished" = FT/AET/PEN.
SELECT 'A_total_fixtures'              AS stage, count(*) AS n FROM fixtures f
UNION ALL
SELECT 'B_finished(FT/AET/PEN)',       count(*) FROM fixtures f
  WHERE f.status_short IN ('FT','AET','PEN')
UNION ALL
SELECT 'C_+has_live_stats',            count(*) FROM fixtures f
  WHERE f.status_short IN ('FT','AET','PEN')
    AND EXISTS (SELECT 1 FROM live_stats ls WHERE ls.fixture_id = f.fixture_id)
UNION ALL
SELECT 'D_+has_match_events(any)',     count(*) FROM fixtures f
  WHERE f.status_short IN ('FT','AET','PEN')
    AND EXISTS (SELECT 1 FROM live_stats ls WHERE ls.fixture_id = f.fixture_id)
    AND EXISTS (SELECT 1 FROM match_events me WHERE me.fixture_id = f.fixture_id)
UNION ALL
SELECT 'E_+has_goal_event',            count(*) FROM fixtures f
  WHERE f.status_short IN ('FT','AET','PEN')
    AND EXISTS (SELECT 1 FROM live_stats ls WHERE ls.fixture_id = f.fixture_id)
    AND EXISTS (SELECT 1 FROM match_events me WHERE me.fixture_id = f.fixture_id AND me.type='Goal')
UNION ALL
SELECT 'F_+season_notnull',            count(*) FROM fixtures f
  WHERE f.status_short IN ('FT','AET','PEN') AND f.season IS NOT NULL
    AND EXISTS (SELECT 1 FROM live_stats ls WHERE ls.fixture_id = f.fixture_id)
    AND EXISTS (SELECT 1 FROM match_events me WHERE me.fixture_id = f.fixture_id AND me.type='Goal')
UNION ALL
SELECT 'G_-exclude_league10',          count(*) FROM fixtures f
  WHERE f.status_short IN ('FT','AET','PEN') AND f.season IS NOT NULL
    AND f.league_id NOT IN (10)
    AND EXISTS (SELECT 1 FROM live_stats ls WHERE ls.fixture_id = f.fixture_id)
    AND EXISTS (SELECT 1 FROM match_events me WHERE me.fixture_id = f.fixture_id AND me.type='Goal')
UNION ALL
SELECT 'H_+has_elo_history(REF only)', count(*) FROM fixtures f
  WHERE f.status_short IN ('FT','AET','PEN') AND f.season IS NOT NULL
    AND f.league_id NOT IN (10)
    AND EXISTS (SELECT 1 FROM live_stats ls WHERE ls.fixture_id = f.fixture_id)
    AND EXISTS (SELECT 1 FROM match_events me WHERE me.fixture_id = f.fixture_id AND me.type='Goal')
    AND EXISTS (SELECT 1 FROM elo_history eh WHERE eh.fixture_id = f.fixture_id)
ORDER BY 1;
\echo '-- (G = pool-ul REAL al codului; elo_history e LEFT JOIN => NU filtrează. H = doar referință.)'

\echo ''
\echo '-- 2b) Diagnostic colaps: din fixturile finished+goluri, câte au live_stats?'
SELECT
  count(*) FILTER (WHERE fin)                                   AS finished_w_goals,
  count(*) FILTER (WHERE fin AND has_ls)                        AS also_live_stats,
  count(*) FILTER (WHERE fin AND NOT has_ls)                    AS MISSING_live_stats,
  round(100.0*count(*) FILTER (WHERE fin AND has_ls)
        / NULLIF(count(*) FILTER (WHERE fin),0), 1)             AS pct_with_live
FROM (
  SELECT (f.status_short IN ('FT','AET','PEN')
          AND f.season IS NOT NULL AND f.league_id NOT IN (10)
          AND EXISTS (SELECT 1 FROM match_events me WHERE me.fixture_id=f.fixture_id AND me.type='Goal')) AS fin,
         EXISTS (SELECT 1 FROM live_stats ls WHERE ls.fixture_id=f.fixture_id) AS has_ls
    FROM fixtures f
) q;

\echo ''
\echo '##############################################################'
\echo '# 3) VARIANTA FĂRĂ MOMENTUM  (secvență doar din match_events + elo)'
\echo '##############################################################'
-- Elimină cerința live_stats. ~27 eșantioane/fixture (T=5..83 pas 3).
SELECT
  count(DISTINCT f.fixture_id)                                   AS eligible_fixtures,
  count(DISTINCT f.fixture_id) * 27                              AS est_samples_T5_85_step3,
  count(DISTINCT f.fixture_id) FILTER
     (WHERE EXISTS (SELECT 1 FROM elo_history eh WHERE eh.fixture_id=f.fixture_id)) AS of_which_with_elo,
  count(DISTINCT f.fixture_id) FILTER
     (WHERE NOT EXISTS (SELECT 1 FROM elo_history eh WHERE eh.fixture_id=f.fixture_id)) AS elo_fallback_1500
FROM fixtures f
WHERE f.status_short IN ('FT','AET','PEN')
  AND f.season IS NOT NULL
  AND f.league_id NOT IN (10)
  AND EXISTS (SELECT 1 FROM match_events me WHERE me.fixture_id=f.fixture_id AND me.type='Goal');

\echo ''
\echo '-- 3b) acoperire pe sezon (variantă fără momentum) — pt split train/test'
SELECT f.season, count(DISTINCT f.fixture_id) AS fixtures
FROM fixtures f
WHERE f.status_short IN ('FT','AET','PEN') AND f.season IS NOT NULL AND f.league_id NOT IN (10)
  AND EXISTS (SELECT 1 FROM match_events me WHERE me.fixture_id=f.fixture_id AND me.type='Goal')
GROUP BY f.season ORDER BY f.season;

\echo ''
\echo '##############################################################'
\echo '# 4) TYPE-MISMATCH pe fixture_id  (string vs int între tabele)'
\echo '##############################################################'
SELECT table_name, data_type, udt_name
FROM information_schema.columns
WHERE column_name = 'fixture_id'
  AND table_name IN ('match_events','live_stats','elo_history','elo_applied',
                     'fixtures','fixtures_history','match_stats','match_snapshots','prematch_data')
ORDER BY data_type, table_name;
\echo '-- Dacă apar tipuri diferite (ex: text vs integer/bigint) => JOIN-urile EXISTS pot rata.'
\echo ''
\echo '== AUDIT COMPLET =='
