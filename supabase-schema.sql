-- AlohaScan — Supabase schema
-- Run this in the Supabase SQL editor to create all required tables.
-- After running, also run the RLS section below.

-- ─── TABLE: predictions ───────────────────────────────────────────────────────
-- Written by: api/enrich.js, api/match.js, api/record.js
-- Updated by: api/update-results.js (fills actual_home_goals, actual_away_goals)
CREATE TABLE IF NOT EXISTS predictions (
  id               SERIAL PRIMARY KEY,
  fixture_id       INTEGER UNIQUE,
  home_team        TEXT,
  away_team        TEXT,
  league_name      TEXT,
  league_id        INTEGER,
  match_date       TIMESTAMP,
  lambda_home      FLOAT,
  lambda_away      FLOAT,
  lambda_total     FLOAT,
  over15_prob      FLOAT,
  over25_prob      FLOAT,
  gg_prob          FLOAT,
  home_score_rate  FLOAT,
  away_score_rate  FLOAT,
  h2h_over15       FLOAT,
  confidence       TEXT,
  actual_home_goals INTEGER,
  actual_away_goals INTEGER,
  result_over15    BOOLEAN,
  result_gg        BOOLEAN,
  recorded_at      TIMESTAMP DEFAULT NOW()
);

-- ─── TABLE: match_snapshots ───────────────────────────────────────────────────
-- Written by: api/cron/scan.js (every minute cron)
-- Stores live match snapshots with NGP/market data, resolved after match ends
CREATE TABLE IF NOT EXISTS match_snapshots (
  id              SERIAL PRIMARY KEY,
  fixture_id      INTEGER,
  league_id       INTEGER,
  league_name     TEXT,
  home_team       TEXT,
  away_team       TEXT,
  home_id         INTEGER,
  away_id         INTEGER,
  status_short    TEXT,
  minute          INTEGER,
  extra_time      INTEGER,
  home_goals      INTEGER DEFAULT 0,
  away_goals      INTEGER DEFAULT 0,
  home_xg         FLOAT DEFAULT 0,
  away_xg         FLOAT DEFAULT 0,
  total_xg        FLOAT DEFAULT 0,
  total_shots     INTEGER DEFAULT 0,
  total_sot       INTEGER DEFAULT 0,
  total_corners   INTEGER DEFAULT 0,
  total_da        INTEGER DEFAULT 0,
  possession      FLOAT DEFAULT 50,
  ng              INTEGER,
  over05          INTEGER,
  over15          INTEGER,
  over25          INTEGER,
  gg              INTEGER,
  outcome         TEXT DEFAULT 'LIVE',
  final_home      INTEGER,
  final_away      INTEGER,
  resolved_at     TIMESTAMP,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ─── TABLE: league_patterns ───────────────────────────────────────────────────
-- Written by: api/cron/scan.js (every 10 runs)
-- Aggregated stats per league based on resolved match snapshots
CREATE TABLE IF NOT EXISTS league_patterns (
  league_id    INTEGER PRIMARY KEY,
  league_name  TEXT,
  sample_size  INTEGER,
  win_rate     INTEGER,
  avg_ng       INTEGER,
  avg_over05   INTEGER,
  avg_over15   INTEGER,
  avg_over25   INTEGER,
  avg_gg       INTEGER,
  updated_at   TIMESTAMP DEFAULT NOW()
);

-- ─── TABLE: pre_match_snapshots ───────────────────────────────────────────────
-- Written by: api/cron/scan.js (pre-match analysis for upcoming fixtures)
CREATE TABLE IF NOT EXISTS pre_match_snapshots (
  id               SERIAL PRIMARY KEY,
  fixture_id       INTEGER UNIQUE,
  home_team        TEXT,
  away_team        TEXT,
  league_id        INTEGER,
  league_name      TEXT,
  kickoff_time     TIMESTAMP,
  gg_score         INTEGER,
  over15_score     INTEGER,
  composite_score  INTEGER,
  h2h_gg_rate      INTEGER,
  h2h_over15_rate  INTEGER,
  home_form_gg     INTEGER,
  away_form_gg     INTEGER,
  outcome          TEXT DEFAULT 'PENDING',
  actual_gg        BOOLEAN,
  actual_over15    BOOLEAN,
  actual_home      INTEGER,
  actual_away      INTEGER,
  resolved_at      TIMESTAMP,
  created_at       TIMESTAMP DEFAULT NOW()
);

-- ─── RLS POLICIES ─────────────────────────────────────────────────────────────
-- IMPORTANT: Use service role key (not anon key) for SUPABASE_KEY in Vercel.
-- The service role key bypasses RLS entirely — no policy changes needed.
-- If you want to use the anon key instead, uncomment the policies below:

/*
ALTER TABLE predictions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_snapshots     ENABLE ROW LEVEL SECURITY;
ALTER TABLE league_patterns     ENABLE ROW LEVEL SECURITY;
ALTER TABLE pre_match_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_all" ON predictions         FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON match_snapshots     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON league_patterns     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all" ON pre_match_snapshots FOR ALL USING (true) WITH CHECK (true);
*/

-- ─── INDEXES (optional, for query performance) ────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_predictions_fixture_id     ON predictions(fixture_id);
CREATE INDEX IF NOT EXISTS idx_match_snapshots_fixture_id ON match_snapshots(fixture_id);
CREATE INDEX IF NOT EXISTS idx_match_snapshots_outcome    ON match_snapshots(outcome);
CREATE INDEX IF NOT EXISTS idx_match_snapshots_created_at ON match_snapshots(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pre_match_fixture_id       ON pre_match_snapshots(fixture_id);
