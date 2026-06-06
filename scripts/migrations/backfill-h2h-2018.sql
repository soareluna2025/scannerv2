-- Migration ONE-TIME: populează h2h din fixtures_history existentă (2018+).
-- Pt meciurile deja procesate de backfill (2026-2022) care n-au rând în h2h
-- fiindcă buildH2H filtra pe ultimii 2 ani. Idempotent (ON CONFLICT DO NOTHING).
-- NU întrerupe backfill-ul curent (doar citește + inserează rânduri lipsă).
--
-- Rulare manuală pe VPS:
--   psql -U alohascan -d elefant -f scripts/migrations/backfill-h2h-2018.sql
--
-- Schema h2h: UNIQUE (team1_id, team2_id, fixture_id); team1/team2 NOT NULL.
-- team1_id = LEAST(home,away), team2_id = GREATEST(home,away) (pereche normalizată).

INSERT INTO h2h
  (team1_id, team2_id, fixture_id, home_team_id, away_team_id,
   match_date, home_goals, away_goals, league_id, season)
SELECT LEAST(home_team_id, away_team_id),
       GREATEST(home_team_id, away_team_id),
       fixture_id, home_team_id, away_team_id,
       match_date, home_goals, away_goals, league_id, season
FROM fixtures_history
WHERE match_date >= '2018-01-01'
  AND home_team_id IS NOT NULL
  AND away_team_id IS NOT NULL
  AND home_team_id <> away_team_id
  AND status_short IN ('FT', 'AET', 'PEN')
ON CONFLICT (team1_id, team2_id, fixture_id) DO NOTHING;

-- Verificare:
SELECT COUNT(*) AS h2h_total FROM h2h;
SELECT COUNT(*) AS h2h_2018plus FROM h2h WHERE match_date >= '2018-01-01';
