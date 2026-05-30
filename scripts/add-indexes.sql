-- add-indexes.sql — indecși de performanță pentru fixtures / fixtures_history
-- Cauza principală a lentorii la /api/matches-history, /api/today, getFormFromDB
-- și batch-ul form_stats din collect-daily (seq scan pe tabele neindexate).
--
-- Aplicare pe VPS:
--   psql -U alohascan -d elefant -f scripts/add-indexes.sql
-- Idempotent (IF NOT EXISTS) — se poate rula de oricâte ori.

-- ── fixtures ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_fixtures_match_date
  ON fixtures(match_date);
CREATE INDEX IF NOT EXISTS idx_fixtures_league_status
  ON fixtures(league_id, status_short);
CREATE INDEX IF NOT EXISTS idx_fixtures_home_team
  ON fixtures(home_team_id);
CREATE INDEX IF NOT EXISTS idx_fixtures_away_team
  ON fixtures(away_team_id);
-- index funcțional pe (match_date::date) — folosit de matches-history (WHERE match_date::date = $1)
CREATE INDEX IF NOT EXISTS idx_fixtures_date_func
  ON fixtures((match_date::date));

-- ── fixtures_history ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_fh_match_date
  ON fixtures_history(match_date);
CREATE INDEX IF NOT EXISTS idx_fh_league_status
  ON fixtures_history(league_id, status_short);
CREATE INDEX IF NOT EXISTS idx_fh_home_team
  ON fixtures_history(home_team_id);
CREATE INDEX IF NOT EXISTS idx_fh_away_team
  ON fixtures_history(away_team_id);
