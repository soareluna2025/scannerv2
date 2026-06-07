-- Migration: features per predicție pentru ML viitor (score1-7 + h2h_sample + league_group).
-- breakdown-ul e DEJA calculat în api/enrich.js; de acum se persistă la fiecare predicție nouă.
-- Datele vechi rămân NULL (normal). Idempotent (ADD COLUMN IF NOT EXISTS).
-- Aplicat automat la startup (server.js ensureColumns). Manual pe VPS:
--   psql -U alohascan -d elefant -f scripts/migrations/add-prediction-features.sql
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS score1 NUMERIC(5,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS score2 NUMERIC(5,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS score3 NUMERIC(5,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS score4 NUMERIC(5,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS score6 NUMERIC(5,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS score7 NUMERIC(5,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS h2h_sample INTEGER;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS league_group TEXT;

-- ELO blend post-scoring (sesiune dedicată) — marcare ajustare ELO per predicție.
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS elo_adjusted BOOLEAN DEFAULT FALSE;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS elo_diff_used NUMERIC(8,2);

-- Features ML: ELO + poziție clasament (populate de backfill-ml-features.sql).
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS home_elo NUMERIC(8,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS away_elo NUMERIC(8,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS elo_diff_ml NUMERIC(8,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS home_win_prob_elo NUMERIC(5,4);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS home_position INTEGER;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS away_position INTEGER;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS home_position_norm NUMERIC(5,4);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS away_position_norm NUMERIC(5,4);
