-- Diagnostic: prematch_data + standings
-- Rulare: psql -U alohascan -d elefant -f scripts/diag-prematch-standings.sql

\echo ''
\echo '=== 1. standings in prematch_data - sample non-empty ==='
SELECT fixture_id, payload::text FROM prematch_data
WHERE data_type = 'standings' AND payload != '[]' LIMIT 1;

\echo ''
\echo '=== 2. standings tabela principala - coloane ==='
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'standings'
ORDER BY ordinal_position;

\echo ''
\echo '=== 3. standings tabela principala - totals ==='
SELECT COUNT(*) AS total,
       COUNT(DISTINCT league_id) AS ligi,
       COUNT(DISTINCT team_id) AS echipe,
       MIN(updated_at)::date AS min_date,
       MAX(updated_at)::date AS max_date
FROM standings;

\echo ''
\echo '=== 4. standings sample (5 randuri) ==='
SELECT league_id, season, team_id, team_name, rank, points,
       played, wins, draws, losses, goals_for, goals_against,
       form, updated_at::date AS updated
FROM standings
ORDER BY updated_at DESC
LIMIT 5;

\echo ''
\echo '=== 5. acoperire standings vs fixtures active ==='
SELECT
  COUNT(DISTINCT f.home_team_id) AS echipe_in_fixtures,
  COUNT(DISTINCT s.team_id)      AS echipe_in_standings,
  COUNT(DISTINCT CASE WHEN s.team_id  IS NOT NULL THEN f.home_team_id END) AS home_acoperite,
  COUNT(DISTINCT CASE WHEN s2.team_id IS NOT NULL THEN f.away_team_id END) AS away_acoperite
FROM fixtures f
LEFT JOIN standings s  ON s.team_id  = f.home_team_id
LEFT JOIN standings s2 ON s2.team_id = f.away_team_id
WHERE f.status_short IN ('NS','1H','HT','2H','ET','BT','P')
  AND f.date >= NOW() - INTERVAL '1 day';

\echo ''
\echo '=== 6. home_form - meciuri per fixture ==='
SELECT
  AVG(jsonb_array_length(payload))::numeric(5,1) AS avg_meciuri,
  MIN(jsonb_array_length(payload)) AS min,
  MAX(jsonb_array_length(payload)) AS max
FROM prematch_data
WHERE data_type = 'home_form' AND payload != '[]';

\echo ''
\echo '=== 7. predictions - coverage campuri cheie ==='
SELECT
  COUNT(*) AS total,
  COUNT(CASE WHEN payload->0->'predictions'->>'under_over' NOT IN ('null','') THEN 1 END) AS has_under_over,
  COUNT(CASE WHEN payload->0->'predictions'->'percent' IS NOT NULL THEN 1 END) AS has_percent,
  COUNT(CASE WHEN payload->0->'comparison'->'total' IS NOT NULL THEN 1 END) AS has_comparison_total,
  COUNT(CASE WHEN payload->0->'comparison'->>'poisson_distribution' IS NOT NULL THEN 1 END) AS has_poisson
FROM prematch_data
WHERE data_type = 'predictions';

\echo ''
\echo '=== 8. predictions - sample valori percent + comparison ==='
SELECT
  fixture_id,
  payload->0->'predictions'->'percent'            AS winner_pct,
  payload->0->'predictions'->>'under_over'         AS under_over,
  payload->0->'comparison'->'total'               AS comparison_total,
  payload->0->'comparison'->'poisson_distribution' AS poisson_dist,
  payload->0->'teams'->'home'->'last_5'->'goals'->'for'->>'average'     AS home_last5_scored,
  payload->0->'teams'->'away'->'last_5'->'goals'->'for'->>'average'     AS away_last5_scored,
  payload->0->'teams'->'home'->'last_5'->'goals'->'against'->>'average' AS home_last5_conceded,
  payload->0->'teams'->'away'->'last_5'->'goals'->'against'->>'average' AS away_last5_conceded
FROM prematch_data
WHERE data_type = 'predictions'
  AND payload->0->'predictions'->'percent' IS NOT NULL
LIMIT 5;
