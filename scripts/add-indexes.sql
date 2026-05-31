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
-- NB: NU indexăm (match_date::date) — castul timestamptz→date NU e IMMUTABLE
-- (depinde de timezone) → PostgreSQL îl respinge. Folosim idx_fixtures_match_date
-- (plain) + interogări pe interval (match_date >= $1 AND < $1+1zi), nu ::date=$1.

-- ── fixtures_history ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_fh_match_date
  ON fixtures_history(match_date);
CREATE INDEX IF NOT EXISTS idx_fh_league_status
  ON fixtures_history(league_id, status_short);
CREATE INDEX IF NOT EXISTS idx_fh_home_team
  ON fixtures_history(home_team_id);
CREATE INDEX IF NOT EXISTS idx_fh_away_team
  ON fixtures_history(away_team_id);
