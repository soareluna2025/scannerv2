-- Migration: adaugă 5 indexuri lipsă pentru query-uri frecvente
-- Aplică cu: PGPASSWORD=... psql -U alohascan -d elefant -h 127.0.0.1 -f scripts/migrations/add-indexes.sql
-- Idempotent — folosește CREATE INDEX IF NOT EXISTS
--
-- Audit ref: ce-am identificat ca lipsă în secțiunea 6 (Baza de date) din
-- raportul de audit complet 23.05.2026.

-- ── PASUL 1 — verificare existență înainte ───────────────────────────────────
\echo '=== Indexuri existente ÎNAINTE ==='
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('fixtures_history', 'fixtures', 'predictions', 'match_snapshots')
ORDER BY tablename, indexname;

-- ── PASUL 2 — creare indexuri ────────────────────────────────────────────────

-- Folosit la: enrich.js:getFormFromDB(), simulate.js:sfHistoryForm(),
--             scanner.js:getFormGoals() — query-ul cel mai des executat
-- Înlocuiește seq scan pe 75.515 rânduri cu index scan
CREATE INDEX IF NOT EXISTS idx_fh_home_status_date
    ON fixtures_history(home_team_id, status_short, match_date DESC);

CREATE INDEX IF NOT EXISTS idx_fh_away_status_date
    ON fixtures_history(away_team_id, status_short, match_date DESC);

-- Folosit la: today.js (meciuri NS în fereastra 30h),
--             scanner.js:scanPreMatch() (sync prematchCache)
CREATE INDEX IF NOT EXISTS idx_fixtures_status_date
    ON fixtures(status_short, match_date);

-- Folosit la: scanner.js:resolveNGPOutcomes() (mn6) —
--             WHERE outcome_ngp='PENDING' AND created_at < NOW() - INTERVAL '5 min'
CREATE INDEX IF NOT EXISTS idx_predictions_outcome
    ON predictions(outcome_ngp);

-- Folosit la: scanner.js:leagueSnapshots() —
--             ORDER BY created_at DESC pentru pattern detection
-- Suprascrie idx_match_snapshots_league (single-col) din add-snapshots.sql
CREATE INDEX IF NOT EXISTS idx_match_snapshots_league_outcome
    ON match_snapshots(league_id, outcome, created_at DESC);

-- ── PASUL 3 — confirmare după ────────────────────────────────────────────────
\echo ''
\echo '=== Indexuri DUPĂ migrare ==='
SELECT indexname
FROM pg_indexes
WHERE tablename IN ('fixtures_history', 'fixtures', 'predictions', 'match_snapshots')
ORDER BY tablename, indexname;
