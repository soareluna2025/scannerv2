-- Migration: adaugă coloane pentru compararea cu predicțiile API-Football
-- și câștigătorul real al meciului
-- Rulează manual pe VPS: psql -U alohascan -d elefant -f scripts/migrations/add-prediction-api-columns.sql

ALTER TABLE predictions ADD COLUMN IF NOT EXISTS api_home_pct  NUMERIC(5,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS api_draw_pct  NUMERIC(5,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS api_away_pct  NUMERIC(5,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS result_winner TEXT;  -- 'home' | 'draw' | 'away'
