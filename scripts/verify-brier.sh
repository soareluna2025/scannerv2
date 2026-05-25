#!/bin/bash
# Verificare completa sistem Brier + self-learning
# Rulare: bash scripts/verify-brier.sh
export PGPASSWORD=Firenze225854
PG() { psql -U alohascan -d elefant -tA -c "$1" 2>/dev/null; }
PGT() { PAGER=cat psql -U alohascan -d elefant -c "$1" 2>/dev/null; }

echo "=== 1. PREDICTION_LOG — volum si stare ==="
PGT "SELECT module,
       COUNT(*) AS total,
       COUNT(CASE WHEN outcome='PENDING' THEN 1 END) AS pending,
       COUNT(CASE WHEN outcome='WIN'     THEN 1 END) AS wins,
       COUNT(CASE WHEN outcome='LOSS'    THEN 1 END) AS losses,
       COUNT(CASE WHEN outcome NOT IN ('PENDING','WIN','LOSS') THEN 1 END) AS altele
     FROM prediction_log
     GROUP BY module ORDER BY module;"

echo ""
echo "=== 2. BRIER SCORE per modul (rezolvate) ==="
PGT "SELECT module,
       COUNT(*) AS sample,
       ROUND(AVG(POWER((predicted_value/100.0) - CASE WHEN outcome='WIN' THEN 1.0 ELSE 0.0 END, 2))::numeric, 4) AS brier_score,
       ROUND(COUNT(CASE WHEN outcome='WIN' THEN 1 END)*100.0/NULLIF(COUNT(*),0), 1) AS win_rate_pct,
       ROUND(AVG(predicted_value)::numeric, 1) AS avg_predicted
     FROM prediction_log
     WHERE outcome IN ('WIN','LOSS')
     GROUP BY module ORDER BY module;"

echo ""
echo "=== 3. BRIER SCORE GLOBAL (OVER15) ==="
PGT "SELECT
       COUNT(*) AS sample_rezolvat,
       ROUND(AVG(POWER((predicted_value/100.0) - CASE WHEN outcome='WIN' THEN 1.0 ELSE 0.0 END, 2))::numeric, 4) AS brier_score,
       CASE
         WHEN AVG(POWER((predicted_value/100.0) - CASE WHEN outcome='WIN' THEN 1.0 ELSE 0.0 END, 2)) < 0.18 THEN 'EXCELENT'
         WHEN AVG(POWER((predicted_value/100.0) - CASE WHEN outcome='WIN' THEN 1.0 ELSE 0.0 END, 2)) < 0.22 THEN 'BUN'
         WHEN AVG(POWER((predicted_value/100.0) - CASE WHEN outcome='WIN' THEN 1.0 ELSE 0.0 END, 2)) < 0.25 THEN 'MEDIU'
         ELSE 'SLAB'
       END AS calificativ,
       MIN(match_date::date) AS prima_predictie,
       MAX(match_date::date) AS ultima_predictie
     FROM prediction_log
     WHERE module='OVER15' AND outcome IN ('WIN','LOSS');"

echo ""
echo "=== 4. CALIBRARE — predicted vs actual pe intervale ==="
PGT "SELECT
       CASE
         WHEN predicted_value < 50 THEN '0-49%'
         WHEN predicted_value < 60 THEN '50-59%'
         WHEN predicted_value < 70 THEN '60-69%'
         WHEN predicted_value < 80 THEN '70-79%'
         ELSE '80-100%'
       END AS bucket,
       COUNT(*) AS total,
       ROUND(COUNT(CASE WHEN outcome='WIN' THEN 1 END)*100.0/NULLIF(COUNT(*),0),1) AS actual_win_rate,
       ROUND(AVG(predicted_value)::numeric,1) AS avg_predicted
     FROM prediction_log
     WHERE module='OVER15' AND outcome IN ('WIN','LOSS')
     GROUP BY 1 ORDER BY 1;"

echo ""
echo "=== 5. PREDICTIONS TABLE — stare rezolvare ==="
PGT "SELECT
       COUNT(*) AS total,
       COUNT(CASE WHEN result_over15 IS NOT NULL THEN 1 END) AS cu_rezultat,
       COUNT(CASE WHEN result_over15 IS NULL AND match_date < NOW() THEN 1 END) AS pending_expirate,
       COUNT(CASE WHEN result_over15 IS NULL AND match_date >= NOW() THEN 1 END) AS viitoare
     FROM predictions;"

echo ""
echo "=== 6. UPDATE-RESULTS — ultimele rulari ==="
PGT "SELECT ran_at::date AS data, status, COALESCE(LEFT(error_msg,80),'') AS eroare
     FROM cron_logs WHERE job_name='update-results'
     ORDER BY ran_at DESC LIMIT 5;"

echo ""
echo "=== 7. MODEL_WEIGHTS — stare curenta ==="
PGT "SELECT module, weight_name,
       weight_value, default_value,
       ROUND(weight_value - default_value, 4) AS drift,
       sample_size, confidence_level
     FROM model_weights
     ORDER BY module, weight_name;"
