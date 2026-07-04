-- fix/gg-recalibration — gg-calib-diagnostic.sql (READ-ONLY, doar SELECT).
-- Diagnostic miscalibrare GG inversată. Sursă = predictions.gg_prob (= EXACT valoarea
-- servită/logată, 1 rând/fixture, result_gg curat din update-results) — mai mult volum
-- și dedup natural vs prediction_log (multiple loguri/fixture). Include și curba din
-- prediction_log (cerința #3) pentru paritate.
-- Rulare: cd /root/scannerv2 && set -a && . ./.env && set +a && psql "$POSTGRES_URL" -f scripts/gg-calib-diagnostic.sql

\echo '== SURSE: volum comparativ (aleg sursa cu mai multe date pt fit) =='
SELECT 'predictions.gg_prob' AS sursa, COUNT(*) AS n_rezolvate
  FROM predictions WHERE result_gg IS NOT NULL AND gg_prob IS NOT NULL
UNION ALL
SELECT 'prediction_log GG', COUNT(*)
  FROM prediction_log WHERE module='GG' AND outcome IN ('WIN','LOSS');

\echo '== (3) CURBA DE CALIBRARE pe benzi de 5 — predictions (pred_avg vs actual_rate + n) =='
SELECT (floor(gg_prob/5)*5)::int AS band,
       COUNT(*) AS n,
       ROUND(AVG(gg_prob),1) AS pred_avg,
       ROUND(100.0*AVG(result_gg::int),1) AS actual_rate,
       ROUND(100.0*AVG(result_gg::int) - AVG(gg_prob),1) AS gap
FROM predictions WHERE result_gg IS NOT NULL AND gg_prob IS NOT NULL
GROUP BY 1 ORDER BY 1;

\echo '== (3b) CURBA din prediction_log GG (cerința #3, paritate) =='
SELECT (floor(predicted_value/5)*5)::int AS band,
       COUNT(*) AS n,
       ROUND(AVG(predicted_value),1) AS pred_avg,
       ROUND(100.0*AVG((outcome='WIN')::int),1) AS actual_rate
FROM prediction_log WHERE module='GG' AND outcome IN ('WIN','LOSS')
GROUP BY 1 ORDER BY 1;

\echo '== (4a) IPOTEZA λ: pe banda 70+ vs sub70 — λ medii + actual GG =='
\echo '   Dacă 70+ are λ mari dar actual_gg mic → λ mari umflă ambele marcaje fără corelația reală.'
SELECT CASE WHEN gg_prob>=70 THEN '70+' ELSE 'sub70' END AS band,
       COUNT(*) AS n,
       ROUND(AVG(lambda_home),2) AS lh, ROUND(AVG(lambda_away),2) AS la,
       ROUND(AVG(LEAST(lambda_home,lambda_away)),2) AS l_min,
       ROUND(AVG(gg_prob),1) AS pred_avg,
       ROUND(100.0*AVG(result_gg::int),1) AS actual_gg
FROM predictions
WHERE result_gg IS NOT NULL AND gg_prob IS NOT NULL AND lambda_home IS NOT NULL AND lambda_away IS NOT NULL
GROUP BY 1 ORDER BY 1;

\echo '== (4b) IPOTEZA per-ligă: banda 70+ dominată de anumite ligi? (gap = actual - pred) =='
SELECT p.league_id, l.name,
       COUNT(*) AS n, ROUND(AVG(p.gg_prob),1) AS pred, ROUND(100.0*AVG(p.result_gg::int),1) AS actual,
       ROUND(100.0*AVG(p.result_gg::int) - AVG(p.gg_prob),1) AS gap
FROM predictions p LEFT JOIN leagues l ON l.league_id=p.league_id
WHERE p.result_gg IS NOT NULL AND p.gg_prob>=70
GROUP BY 1,2 HAVING COUNT(*)>=30 ORDER BY n DESC LIMIT 20;

\echo '== (4c) GLOBAL: volum rezolvat per an (fezabilitate fit + split temporal 2026) =='
SELECT date_part('year',match_date)::int AS an, COUNT(*) AS n_rezolvate,
       ROUND(AVG(gg_prob),1) AS pred_avg, ROUND(100.0*AVG(result_gg::int),1) AS actual_rate
FROM predictions WHERE result_gg IS NOT NULL AND gg_prob IS NOT NULL
GROUP BY 1 ORDER BY 1;

\echo 'INTERPRETARE: dacă gap-ul (4b) e uniform pe ligi → problemă GLOBALĂ → calibrare isotonic OK.'
\echo 'Dacă gap-ul e concentrat pe câteva ligi → NU forța calibrare globală (raportează, STOP).'
