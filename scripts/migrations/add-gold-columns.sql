-- add-gold-columns.sql — „recolta de aur" (date deja plătite, zero apeluri API noi).
-- Idempotent (ADD COLUMN IF NOT EXISTS). Aplicat la boot (server.js ensureColumns)
-- + în create-tables.sql. DOAR salvare — nimic nu intră încă în model.

-- #1 referee la colectarea curentă (fixtures NS); fixtures_history are deja referee.
ALTER TABLE fixtures         ADD COLUMN IF NOT EXISTS referee TEXT;

-- #4 formații din /fixtures/lineups (deja cerut în match.js)
ALTER TABLE fixtures_history ADD COLUMN IF NOT EXISTS home_formation TEXT;
ALTER TABLE fixtures_history ADD COLUMN IF NOT EXISTS away_formation TEXT;

-- #5a xG defensiv (goals_prevented) din /fixtures/statistics, lângă expected_goals
ALTER TABLE match_stats      ADD COLUMN IF NOT EXISTS goals_prevented NUMERIC(5,2);

-- #5b standings home/away splits (P/W/D/L/GF/GA acasă și deplasare)
ALTER TABLE standings ADD COLUMN IF NOT EXISTS played_home INTEGER;
ALTER TABLE standings ADD COLUMN IF NOT EXISTS win_home    INTEGER;
ALTER TABLE standings ADD COLUMN IF NOT EXISTS draw_home   INTEGER;
ALTER TABLE standings ADD COLUMN IF NOT EXISTS lose_home   INTEGER;
ALTER TABLE standings ADD COLUMN IF NOT EXISTS gf_home     INTEGER;
ALTER TABLE standings ADD COLUMN IF NOT EXISTS ga_home     INTEGER;
ALTER TABLE standings ADD COLUMN IF NOT EXISTS played_away INTEGER;
ALTER TABLE standings ADD COLUMN IF NOT EXISTS win_away    INTEGER;
ALTER TABLE standings ADD COLUMN IF NOT EXISTS draw_away   INTEGER;
ALTER TABLE standings ADD COLUMN IF NOT EXISTS lose_away   INTEGER;
ALTER TABLE standings ADD COLUMN IF NOT EXISTS gf_away     INTEGER;
ALTER TABLE standings ADD COLUMN IF NOT EXISTS ga_away     INTEGER;

-- #3 API comparison + advice din /predictions (lângă api_*_pct existente)
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS api_advice           TEXT;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS api_cmp_form_home    NUMERIC(5,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS api_cmp_form_away    NUMERIC(5,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS api_cmp_att_home     NUMERIC(5,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS api_cmp_att_away     NUMERIC(5,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS api_cmp_def_home     NUMERIC(5,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS api_cmp_def_away     NUMERIC(5,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS api_cmp_poisson_home NUMERIC(5,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS api_cmp_poisson_away NUMERIC(5,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS api_cmp_h2h_home     NUMERIC(5,2);
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS api_cmp_h2h_away     NUMERIC(5,2);
