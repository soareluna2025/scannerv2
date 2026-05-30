-- cleanup-old-data.sql — șterge date mai vechi de 2 ani (cutoff: 2024-05-30)
-- Politică retenție AlohaScan: păstrăm DOAR ultimii 2 ani de date istorice.
--
-- ⚠ ORDINE STRICTĂ: copii (player_stats, match_events) ÎNAINTE de părinte
--   (fixtures_history), fiindcă filtrarea lor se face prin JOIN pe match_date.
-- ⚠ Rulează backup ÎNAINTE (vezi instrucțiunile din SESSION_CONTEXT / chat).
-- ⚠ NU atinge: form_stats, standings, referee_stats, coach_stats, league_stats,
--   bets (agregate „curente" / cataloage statice — nu conțin istorie brută).
--
-- Aplicare pe VPS:
--   psql -U alohascan -d elefant -f scripts/cleanup-old-data.sql

\echo '=== Înainte de ștergere ==='
SELECT 'fixtures_history' AS tabela, COUNT(*) AS total,
       COUNT(*) FILTER (WHERE match_date < '2024-05-30') AS de_sters FROM fixtures_history
UNION ALL SELECT 'h2h', COUNT(*), COUNT(*) FILTER (WHERE match_date < '2024-05-30') FROM h2h;

BEGIN;

-- 1. player_stats vechi (fără dată proprie → JOIN pe fixtures_history)
DELETE FROM player_stats
WHERE fixture_id IN (
  SELECT fixture_id FROM fixtures_history
  WHERE match_date < '2024-05-30'
);

-- 2. match_events vechi (fără dată proprie → JOIN pe fixtures_history)
DELETE FROM match_events
WHERE fixture_id IN (
  SELECT fixture_id FROM fixtures_history
  WHERE match_date < '2024-05-30'
);

-- 3. h2h vechi (are match_date propriu)
DELETE FROM h2h WHERE match_date < '2024-05-30';

-- 4. fixtures_history vechi (părintele — ultimul)
DELETE FROM fixtures_history WHERE match_date < '2024-05-30';

COMMIT;

-- 5. VACUUM ANALYZE — eliberează spațiu + actualizează statistici planner
--    (VACUUM nu poate rula în tranzacție → după COMMIT)
VACUUM ANALYZE fixtures_history;
VACUUM ANALYZE h2h;
VACUUM ANALYZE player_stats;
VACUUM ANALYZE match_events;

\echo '=== După ștergere ==='
SELECT 'fixtures_history' AS tabela, COUNT(*) AS ramase FROM fixtures_history
UNION ALL SELECT 'h2h', COUNT(*) FROM h2h
UNION ALL SELECT 'player_stats', COUNT(*) FROM player_stats
UNION ALL SELECT 'match_events', COUNT(*) FROM match_events;
