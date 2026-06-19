-- Migration: 12 coloane „timing goluri" în ml_features (feature store ML).
-- Aditiv, idempotent (ADD COLUMN IF NOT EXISTS) — nu atinge formule/scoring.
-- Sursa de calcul: api/utils/goal-timing-sql.js (build-ml-features.js scrie aici;
-- enrich.js recalculează identic pt serving). Folosite DOAR de piețele HT/R2 în train_model.
-- Aplicare manuală pe VPS:
--   psql -U alohascan -d elefant -f scripts/migrations/add-ml-features-timing.sql
ALTER TABLE ml_features ADD COLUMN IF NOT EXISTS home_tm_scored_r2_share     NUMERIC;
ALTER TABLE ml_features ADD COLUMN IF NOT EXISTS away_tm_scored_r2_share     NUMERIC;
ALTER TABLE ml_features ADD COLUMN IF NOT EXISTS home_tm_conceded_r2_share   NUMERIC;
ALTER TABLE ml_features ADD COLUMN IF NOT EXISTS away_tm_conceded_r2_share   NUMERIC;
ALTER TABLE ml_features ADD COLUMN IF NOT EXISTS home_tm_scored_late_share   NUMERIC;
ALTER TABLE ml_features ADD COLUMN IF NOT EXISTS away_tm_scored_late_share   NUMERIC;
ALTER TABLE ml_features ADD COLUMN IF NOT EXISTS home_tm_conceded_late_share NUMERIC;
ALTER TABLE ml_features ADD COLUMN IF NOT EXISTS away_tm_conceded_late_share NUMERIC;
ALTER TABLE ml_features ADD COLUMN IF NOT EXISTS home_tm_scored_r1_rate      NUMERIC;
ALTER TABLE ml_features ADD COLUMN IF NOT EXISTS away_tm_scored_r1_rate      NUMERIC;
ALTER TABLE ml_features ADD COLUMN IF NOT EXISTS home_tm_scored_r2_rate      NUMERIC;
ALTER TABLE ml_features ADD COLUMN IF NOT EXISTS away_tm_scored_r2_rate      NUMERIC;
