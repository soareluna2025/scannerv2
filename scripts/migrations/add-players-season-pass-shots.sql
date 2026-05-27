-- Adauga pass_accuracy si shots_on_target in players_season
-- Necesare pentru L2 (getLineupStrengthFactor) in api/enrich.js
-- Rulare manuala pe VPS: psql -U alohascan -d elefant -f scripts/migrations/add-players-season-pass-shots.sql

ALTER TABLE players_season
  ADD COLUMN IF NOT EXISTS pass_accuracy   NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS shots_on_target INTEGER;
