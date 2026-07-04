-- Faza 2 — pit-verify.sql (READ-ONLY). Verificare după pit-recompute.
-- Rulare (Termius, o linie):
--   cd /root/scannerv2 && set -a && . ./.env && set +a && psql "$POSTGRES_URL" -f scripts/pit-verify.sql

\echo '== (a) ACOPERIRE per an: cu pit_score7 vs total ml_features =='
SELECT date_part('year', fh.match_date)::int AS an,
       COUNT(*)                                          AS total_mlf,
       COUNT(*) FILTER (WHERE mf.pit_players_n IS NOT NULL) AS procesate,
       COUNT(mf.pit_score7)                              AS cu_pit_s7,
       ROUND(100.0*COUNT(mf.pit_score7)/NULLIF(COUNT(*),0),1) AS pct_s7,
       COUNT(mf.pit_confidence)                          AS cu_pit_conf
FROM ml_features mf
JOIN fixtures_history fh ON fh.fixture_id = mf.fixture_id
GROUP BY 1 ORDER BY 1;

\echo '== (b) SANITY replicare formulă pe 2026 (pit vs score7 LIVE din predictions) =='
\echo '   diff mic (<~10) = formula replicată corect. NB: prod ordonează pe fixture_id DESC,'
\echo '   PIT pe match_date< → mică divergență AȘTEPTATĂ; diff mare (>15) = STOP, replicare greșită.'
SELECT COUNT(*) AS n,
       ROUND(AVG(ABS(mf.pit_score7 - p.score7)),2) AS diff_mediu,
       ROUND(MAX(ABS(mf.pit_score7 - p.score7)),2) AS diff_max,
       ROUND(STDDEV_POP(mf.pit_score7 - p.score7),2) AS diff_std
FROM ml_features mf
JOIN fixtures_history fh ON fh.fixture_id = mf.fixture_id
JOIN predictions p ON p.fixture_id = mf.fixture_id
WHERE date_part('year', fh.match_date) = 2026
  AND mf.pit_score7 IS NOT NULL AND p.score7 IS NOT NULL;

\echo '== (c) DISTRIBUȚII per an (nu constante, nu NULL masiv) =='
SELECT date_part('year', fh.match_date)::int AS an,
       MIN(mf.pit_score7) s7_min, ROUND(AVG(mf.pit_score7),1) s7_avg, MAX(mf.pit_score7) s7_max,
       MIN(mf.pit_confidence) conf_min, ROUND(AVG(mf.pit_confidence),1) conf_avg, MAX(mf.pit_confidence) conf_max,
       ROUND(AVG(mf.pit_players_n),0) players_n_avg
FROM ml_features mf
JOIN fixtures_history fh ON fh.fixture_id = mf.fixture_id
WHERE mf.pit_score7 IS NOT NULL
GROUP BY 1 ORDER BY 1;

\echo '== (d) ANTI-LEAKAGE spot-check (3 fixturi 2023): fereastra folosită e STRICT anterioară =='
WITH sample AS (
  SELECT mf.fixture_id, fh.match_date, fh.home_team_id
  FROM ml_features mf
  JOIN fixtures_history fh ON fh.fixture_id = mf.fixture_id
  WHERE mf.pit_score7 IS NOT NULL AND date_part('year', fh.match_date) = 2023
  ORDER BY mf.fixture_id LIMIT 3
)
SELECT s.fixture_id, s.match_date AS data_meci, s.home_team_id,
       COUNT(*) AS randuri_fereastra,
       MAX(fhh.match_date) AS cea_mai_recenta_din_fereastra,
       (MAX(fhh.match_date) < s.match_date) AS strict_anterior
FROM sample s
JOIN player_stats ps ON ps.team_id = s.home_team_id
JOIN fixtures_history fhh ON fhh.fixture_id = ps.fixture_id AND fhh.match_date < s.match_date
GROUP BY 1,2,3 ORDER BY 1;
