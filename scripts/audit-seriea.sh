#!/usr/bin/env bash
# =====================================================================
# audit-seriea.sh — RAPORT COMPLET read-only despre Serie A Italia
# AlohaScan V2 — diagnostic per ligă (pilot)
#
# Rulare:   git pull && bash scripts/audit-seriea.sh
# Salvare:  git pull && bash scripts/audit-seriea.sh > /root/seriea-audit.txt 2>&1
#
# SIGURANTA: doar SELECT-uri. Nu scrie, nu modifica, nu atinge nimic.
# Fara 'set -e' intentionat: daca o sectiune da eroare, restul continua.
# =====================================================================

DB="psql -U alohascan -d elefant -P pager=off"
DBA="psql -U alohascan -d elefant -tA -P pager=off"

LID=$($DBA -c "SELECT league_id FROM leagues WHERE country ILIKE '%ital%' AND tier=1 AND name ILIKE '%serie a%' ORDER BY league_id LIMIT 1;")
if [ -z "$LID" ]; then
  echo "Nu am gasit Serie A Italia (country~ital, tier=1, name~serie a). Verifica tabela leagues manual."
  exit 1
fi

echo "=================================================================="
echo " RAPORT SERIE A ITALIA   |   league_id=$LID"
echo " Generat: $(date)"
echo "=================================================================="

echo ""
echo "### 1) META LIGA"
$DB -c "SELECT league_id, name, country, tier, active, timezone, active_hours_start, active_hours_end, updated_at FROM leagues WHERE league_id=$LID;"

echo ""
echo "### 2) ECHIPE & ELO"
$DB -c "SELECT COUNT(*) AS echipe, ROUND(MIN(elo)) AS elo_min, ROUND(AVG(elo)) AS elo_mediu, ROUND(MAX(elo)) AS elo_max, ROUND(STDDEV(elo)) AS elo_std, SUM(CASE WHEN games<5 THEN 1 ELSE 0 END) AS echipe_sub5meciuri FROM elo_ratings WHERE league_id=$LID;"
echo "-- Top 10 ELO --"
$DB -c "SELECT team_id, ROUND(elo) AS elo, games FROM elo_ratings WHERE league_id=$LID ORDER BY elo DESC LIMIT 10;"
echo "-- Bottom 5 ELO --"
$DB -c "SELECT team_id, ROUND(elo) AS elo, games FROM elo_ratings WHERE league_id=$LID ORDER BY elo ASC LIMIT 5;"

echo ""
echo "### 3) ACOPERIRE DATE"
$DB -c "SELECT COUNT(*) AS total_predictii, MIN(match_date) AS prima, MAX(match_date) AS ultima, COUNT(result_over15) AS cu_rez_over15, COUNT(result_over25) AS cu_rez_over25, COUNT(result_gg) AS cu_rez_gg, COUNT(result_1x2) AS cu_rez_1x2 FROM predictions WHERE league_id=$LID;"
echo "-- Pe luna --"
$DB -c "SELECT date_trunc('month', match_date)::date AS luna, COUNT(*) AS meciuri, COUNT(result_over15) AS cu_rezultat FROM predictions WHERE league_id=$LID GROUP BY 1 ORDER BY 1;"

echo ""
echo "### 4) SHAPE / SCALE"
$DB -c "SELECT 'over15_prob' AS col, ROUND(MIN(over15_prob)::numeric,3) AS min, ROUND(AVG(over15_prob)::numeric,3) AS avg, ROUND(MAX(over15_prob)::numeric,3) AS max FROM predictions WHERE league_id=$LID UNION ALL SELECT 'over25_prob', ROUND(MIN(over25_prob)::numeric,3), ROUND(AVG(over25_prob)::numeric,3), ROUND(MAX(over25_prob)::numeric,3) FROM predictions WHERE league_id=$LID UNION ALL SELECT 'gg_prob', ROUND(MIN(gg_prob)::numeric,3), ROUND(AVG(gg_prob)::numeric,3), ROUND(MAX(gg_prob)::numeric,3) FROM predictions WHERE league_id=$LID UNION ALL SELECT 'confidence', ROUND(MIN(confidence)::numeric,3), ROUND(AVG(confidence)::numeric,3), ROUND(MAX(confidence)::numeric,3) FROM predictions WHERE league_id=$LID;"
echo "-- Valori distincte result_* --"
$DB -c "SELECT 'result_over15' AS col, array_agg(DISTINCT result_over15::text) AS valori FROM predictions WHERE league_id=$LID UNION ALL SELECT 'result_over25', array_agg(DISTINCT result_over25::text) FROM predictions WHERE league_id=$LID UNION ALL SELECT 'result_gg', array_agg(DISTINCT result_gg::text) FROM predictions WHERE league_id=$LID UNION ALL SELECT 'result_1x2', array_agg(DISTINCT result_1x2::text) FROM predictions WHERE league_id=$LID;"

echo ""
echo "### 5) ACURATETE / BRIER pe market (scala auto-detectata)"
echo "-- OVER 1.5 --"
$DB -c "WITH base AS (SELECT (CASE WHEN result_over15::text IN ('1','t','true','TRUE','Y','y') THEN 1 WHEN result_over15::text IN ('0','f','false','FALSE','N','n') THEN 0 END) AS r, over15_prob AS p FROM predictions WHERE league_id=$LID AND result_over15 IS NOT NULL AND over15_prob IS NOT NULL), sc AS (SELECT CASE WHEN MAX(p)>1.5 THEN 100.0 ELSE 1.0 END AS f FROM base) SELECT 'over15' AS market, COUNT(*) AS n, ROUND(AVG(r)::numeric,4) AS rata_reala, ROUND(AVG(p/sc.f)::numeric,4) AS pred_mediu, ROUND(AVG(power(p/sc.f - r,2))::numeric,4) AS brier FROM base CROSS JOIN sc WHERE r IS NOT NULL;"
echo "-- OVER 2.5 --"
$DB -c "WITH base AS (SELECT (CASE WHEN result_over25::text IN ('1','t','true','TRUE','Y','y') THEN 1 WHEN result_over25::text IN ('0','f','false','FALSE','N','n') THEN 0 END) AS r, over25_prob AS p FROM predictions WHERE league_id=$LID AND result_over25 IS NOT NULL AND over25_prob IS NOT NULL), sc AS (SELECT CASE WHEN MAX(p)>1.5 THEN 100.0 ELSE 1.0 END AS f FROM base) SELECT 'over25' AS market, COUNT(*) AS n, ROUND(AVG(r)::numeric,4) AS rata_reala, ROUND(AVG(p/sc.f)::numeric,4) AS pred_mediu, ROUND(AVG(power(p/sc.f - r,2))::numeric,4) AS brier FROM base CROSS JOIN sc WHERE r IS NOT NULL;"
echo "-- GG --"
$DB -c "WITH base AS (SELECT (CASE WHEN result_gg::text IN ('1','t','true','TRUE','Y','y') THEN 1 WHEN result_gg::text IN ('0','f','false','FALSE','N','n') THEN 0 END) AS r, gg_prob AS p FROM predictions WHERE league_id=$LID AND result_gg IS NOT NULL AND gg_prob IS NOT NULL), sc AS (SELECT CASE WHEN MAX(p)>1.5 THEN 100.0 ELSE 1.0 END AS f FROM base) SELECT 'gg' AS market, COUNT(*) AS n, ROUND(AVG(r)::numeric,4) AS rata_reala, ROUND(AVG(p/sc.f)::numeric,4) AS pred_mediu, ROUND(AVG(power(p/sc.f - r,2))::numeric,4) AS brier FROM base CROSS JOIN sc WHERE r IS NOT NULL;"

echo ""
echo "### 6) CALIBRARE: confidence vs over15 real (5 buckets)"
$DB -c "SELECT bucket, COUNT(*) AS n, ROUND(MIN(confidence)::numeric,2) AS conf_min, ROUND(MAX(confidence)::numeric,2) AS conf_max, ROUND(AVG(CASE WHEN result_over15::text IN ('1','t','true','TRUE','Y','y') THEN 1.0 WHEN result_over15::text IN ('0','f','false','FALSE','N','n') THEN 0.0 END)::numeric,4) AS over15_real FROM (SELECT confidence, result_over15, NTILE(5) OVER (ORDER BY confidence) AS bucket FROM predictions WHERE league_id=$LID AND confidence IS NOT NULL AND result_over15 IS NOT NULL) t GROUP BY bucket ORDER BY bucket;"

echo ""
echo "### 7) SCORE 1-7 (distributie + null rate)"
$DB -c "SELECT 'score1' AS s, COUNT(score1) AS non_null, COUNT(*)-COUNT(score1) AS nuluri, ROUND(AVG(score1)::numeric,3) AS avg, ROUND(MIN(score1)::numeric,2) AS min, ROUND(MAX(score1)::numeric,2) AS max FROM predictions WHERE league_id=$LID UNION ALL SELECT 'score2', COUNT(score2), COUNT(*)-COUNT(score2), ROUND(AVG(score2)::numeric,3), ROUND(MIN(score2)::numeric,2), ROUND(MAX(score2)::numeric,2) FROM predictions WHERE league_id=$LID UNION ALL SELECT 'score3', COUNT(score3), COUNT(*)-COUNT(score3), ROUND(AVG(score3)::numeric,3), ROUND(MIN(score3)::numeric,2), ROUND(MAX(score3)::numeric,2) FROM predictions WHERE league_id=$LID UNION ALL SELECT 'score4', COUNT(score4), COUNT(*)-COUNT(score4), ROUND(AVG(score4)::numeric,3), ROUND(MIN(score4)::numeric,2), ROUND(MAX(score4)::numeric,2) FROM predictions WHERE league_id=$LID UNION ALL SELECT 'score6', COUNT(score6), COUNT(*)-COUNT(score6), ROUND(AVG(score6)::numeric,3), ROUND(MIN(score6)::numeric,2), ROUND(MAX(score6)::numeric,2) FROM predictions WHERE league_id=$LID UNION ALL SELECT 'score7', COUNT(score7), COUNT(*)-COUNT(score7), ROUND(AVG(score7)::numeric,3), ROUND(MIN(score7)::numeric,2), ROUND(MAX(score7)::numeric,2) FROM predictions WHERE league_id=$LID;"

echo ""
echo "### 8) ML_FEATURES — acoperire pe Serie A"
$DB -c "WITH f AS (SELECT m.* FROM ml_features m JOIN predictions p ON p.fixture_id=m.fixture_id WHERE p.league_id=$LID) SELECT COUNT(*) AS fixtures_cu_features, ROUND(100.0*COUNT(home_xg_avg)/NULLIF(COUNT(*),0),1) AS pct_xg, ROUND(100.0*COUNT(home_sot_avg)/NULLIF(COUNT(*),0),1) AS pct_sot, ROUND(100.0*COUNT(home_corners_avg)/NULLIF(COUNT(*),0),1) AS pct_corners, ROUND(100.0*COUNT(home_possession_avg)/NULLIF(COUNT(*),0),1) AS pct_possession, ROUND(100.0*COUNT(home_goals_r1_avg)/NULLIF(COUNT(*),0),1) AS pct_goluri_r1, ROUND(100.0*COUNT(home_goals_r2_avg)/NULLIF(COUNT(*),0),1) AS pct_goluri_r2 FROM f;"

echo ""
echo "### 9) CALIBRARE existenta (calibration_tables)"
$DB -c "SELECT module, league_group, sample_size, ROUND(brier_score::numeric,4) AS brier, generated_at FROM calibration_tables WHERE league_group IN (SELECT DISTINCT league_group FROM predictions WHERE league_id=$LID AND league_group IS NOT NULL) ORDER BY module, league_group;"

echo ""
echo "### 10) ANOMALII & FLAG-URI"
echo "-- ELO outlieri (elo<800 sau >2000) --"
$DB -c "SELECT team_id, ROUND(elo) AS elo, games FROM elo_ratings WHERE league_id=$LID AND (elo<800 OR elo>2000) ORDER BY elo;"
echo "-- Meciuri trecute fara rezultat --"
$DB -c "SELECT COUNT(*) AS meciuri_trecute_fara_rezultat FROM predictions WHERE league_id=$LID AND match_date < NOW() AND result_over15 IS NULL;"
echo "-- Predictii cu probabilitati core NULL --"
$DB -c "SELECT COUNT(*) AS predictii_cu_prob_null FROM predictions WHERE league_id=$LID AND (over15_prob IS NULL OR over25_prob IS NULL OR gg_prob IS NULL);"

echo ""
echo "=================================================================="
echo " SFARSIT RAPORT SERIE A"
echo "=================================================================="
