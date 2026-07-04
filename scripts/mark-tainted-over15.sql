-- P1c — mark-tainted-over15.sql
-- Marchează (NU șterge) rândurile OVER15 tautologice: logate când scorul avea
-- deja total>=2 goluri → over15 era deja decis (hit ~100% fals). Păstrăm audit trail
-- cu outcome='TAINTED' ca să fie EXCLUSE din learning (P4c filtrează TAINTED).
-- Rulare (Termius, o linie):
--   cd /root/scannerv2 && set -a && . ./.env && set +a && psql "$POSTGRES_URL" -f scripts/mark-tainted-over15.sql

\echo '== Câte rânduri OVER15 vor fi marcate TAINTED (total_la_predictie>=2) =='
SELECT COUNT(*) AS de_marcat
FROM prediction_log
WHERE module='OVER15'
  AND outcome IN ('WIN','LOSS')
  AND score_at_prediction ~ '^[0-9]+-[0-9]+$'
  AND (split_part(score_at_prediction,'-',1)::int + split_part(score_at_prediction,'-',2)::int) >= 2;

\echo '== Aplic UPDATE outcome=TAINTED... =='
UPDATE prediction_log SET outcome='TAINTED'
WHERE module='OVER15'
  AND outcome IN ('WIN','LOSS')
  AND score_at_prediction ~ '^[0-9]+-[0-9]+$'
  AND (split_part(score_at_prediction,'-',1)::int + split_part(score_at_prediction,'-',2)::int) >= 2;

\echo '== Total TAINTED după update =='
SELECT COUNT(*) AS tainted_total FROM prediction_log WHERE outcome='TAINTED';

\echo '== OVER15 curat rămas (total 0-1) pe benzi de predicted_value =='
SELECT CASE WHEN predicted_value<75 THEN '1_lt75'
            WHEN predicted_value<85 THEN '2_75-84'
            ELSE '3_ge85' END AS band,
       COUNT(*) AS n,
       ROUND(100.0*AVG((outcome='WIN')::int),1) AS hit
FROM prediction_log
WHERE module='OVER15' AND outcome IN ('WIN','LOSS')
GROUP BY 1 ORDER BY 1;
