-- P0 — rerezolve-confidence.sql
-- Re-rezolvă TOATE rândurile module='CONFIDENCE' cu outcome IN ('WIN','LOSS')
-- după regula NOUĂ prag-unic 50, din fixtures_history (JOIN pe fixture_id).
-- Elimină artefactul benzii moarte [45,55) care ieșea determinist LOSS.
-- READ-FIRST: raportează tranzițiile ÎNAINTE de UPDATE, apoi aplică.
-- Rulare (Termius, o linie):
--   cd /root/scannerv2 && set -a && . ./.env && set +a && psql "$POSTGRES_URL" -f scripts/rerezolve-confidence.sql

\echo '== Tranziții CONFIDENCE (regula nouă prag 50) — ÎNAINTE de UPDATE =='
SELECT
  COUNT(*) FILTER (WHERE pl.outcome='LOSS' AND x.newout='WIN')  AS loss_to_win,
  COUNT(*) FILTER (WHERE pl.outcome='WIN'  AND x.newout='LOSS') AS win_to_loss,
  COUNT(*) FILTER (WHERE pl.outcome = x.newout)                AS neschimbat,
  COUNT(*)                                                     AS total_evaluat
FROM prediction_log pl
JOIN fixtures_history fh ON fh.fixture_id = pl.fixture_id
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN (pl.predicted_value>=50 AND (fh.home_goals+fh.away_goals)>=2)
      OR (pl.predicted_value<50  AND (fh.home_goals+fh.away_goals)<2)
    THEN 'WIN' ELSE 'LOSS' END AS newout
) x
WHERE pl.module='CONFIDENCE'
  AND pl.outcome IN ('WIN','LOSS')
  AND fh.status_short IN ('FT','AET','PEN')
  AND fh.home_goals IS NOT NULL AND fh.away_goals IS NOT NULL;

\echo '== Aplic UPDATE... =='
UPDATE prediction_log pl SET
  outcome = CASE
    WHEN (pl.predicted_value>=50 AND (fh.home_goals+fh.away_goals)>=2)
      OR (pl.predicted_value<50  AND (fh.home_goals+fh.away_goals)<2)
    THEN 'WIN' ELSE 'LOSS' END,
  actual_value = fh.home_goals + fh.away_goals,
  resolved_at  = NOW()
FROM fixtures_history fh
WHERE pl.fixture_id = fh.fixture_id
  AND pl.module='CONFIDENCE'
  AND pl.outcome IN ('WIN','LOSS')
  AND fh.status_short IN ('FT','AET','PEN')
  AND fh.home_goals IS NOT NULL AND fh.away_goals IS NOT NULL;

\echo '== Verificare: hit-rate CONFIDENCE pe benzi (banda 45-55 trebuie hit>0 acum) =='
SELECT CASE WHEN predicted_value<45 THEN '1_lt45'
            WHEN predicted_value<55 THEN '2_45-55'
            ELSE '3_ge55' END AS band,
       COUNT(*) AS n,
       ROUND(100.0*AVG((outcome='WIN')::int),1) AS hit
FROM prediction_log
WHERE module='CONFIDENCE' AND outcome IN ('WIN','LOSS')
GROUP BY 1 ORDER BY 1;
