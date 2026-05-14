-- AlohaScan — Schema Expansion v2
-- Run this in Supabase SQL Editor
-- Safe to run multiple times (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)

-- EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- =====================
-- NEW TABLES
-- =====================

CREATE TABLE IF NOT EXISTS leagues (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  country     TEXT,
  logo        TEXT,
  season      INTEGER,
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS teams (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  short_name  TEXT,
  country     TEXT,
  logo        TEXT,
  league_id   INTEGER REFERENCES leagues(id),
  founded     INTEGER,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS players (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  firstname    TEXT,
  lastname     TEXT,
  age          INTEGER,
  position     TEXT,
  nationality  TEXT,
  photo        TEXT,
  team_id      INTEGER REFERENCES teams(id),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fixtures (
  id              INTEGER PRIMARY KEY,
  league_id       INTEGER REFERENCES leagues(id),
  season          INTEGER,
  home_team_id    INTEGER REFERENCES teams(id),
  away_team_id    INTEGER REFERENCES teams(id),
  home_team_name  TEXT,
  away_team_name  TEXT,
  kickoff_time    TIMESTAMPTZ,
  status_short    TEXT,
  status_long     TEXT,
  minute          INTEGER,
  home_goals      INTEGER,
  away_goals      INTEGER,
  venue           TEXT,
  referee         TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS standings (
  id             SERIAL PRIMARY KEY,
  league_id      INTEGER REFERENCES leagues(id),
  season         INTEGER,
  team_id        INTEGER REFERENCES teams(id),
  team_name      TEXT,
  rank           INTEGER,
  points         INTEGER,
  goals_for      INTEGER,
  goals_against  INTEGER,
  goal_diff      INTEGER,
  played         INTEGER,
  won            INTEGER,
  drawn          INTEGER,
  lost           INTEGER,
  form           TEXT,
  home_played    INTEGER,
  away_played    INTEGER,
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(league_id, season, team_id)
);

CREATE TABLE IF NOT EXISTS match_stats (
  id               SERIAL PRIMARY KEY,
  fixture_id       INTEGER REFERENCES fixtures(id),
  team_id          INTEGER REFERENCES teams(id),
  team_name        TEXT,
  is_home          BOOLEAN,
  possession       NUMERIC(5,2),
  shots_total      INTEGER,
  shots_on_target  INTEGER,
  shots_off_target INTEGER,
  shots_blocked    INTEGER,
  xg               NUMERIC(6,3),
  corners          INTEGER,
  fouls            INTEGER,
  yellow_cards     INTEGER,
  red_cards        INTEGER,
  offsides         INTEGER,
  passes_total     INTEGER,
  passes_accurate  INTEGER,
  pass_accuracy    NUMERIC(5,2),
  attacks          INTEGER,
  dangerous_attacks INTEGER,
  ball_safe        INTEGER,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(fixture_id, team_id)
);

CREATE TABLE IF NOT EXISTS match_events (
  id             SERIAL PRIMARY KEY,
  fixture_id     INTEGER REFERENCES fixtures(id),
  team_id        INTEGER REFERENCES teams(id),
  player_id      INTEGER,
  player_name    TEXT,
  assist_id      INTEGER,
  assist_name    TEXT,
  event_type     TEXT,
  event_detail   TEXT,
  event_comment  TEXT,
  minute         INTEGER,
  extra_time     INTEGER,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS live_stats (
  id                SERIAL PRIMARY KEY,
  fixture_id        INTEGER REFERENCES fixtures(id),
  minute            INTEGER,
  home_goals        INTEGER,
  away_goals        INTEGER,
  home_possession   NUMERIC(5,2),
  away_possession   NUMERIC(5,2),
  home_xg           NUMERIC(6,3),
  away_xg           NUMERIC(6,3),
  home_shots        INTEGER,
  away_shots        INTEGER,
  home_attacks      INTEGER,
  away_attacks      INTEGER,
  home_dangerous    INTEGER,
  away_dangerous    INTEGER,
  home_corners      INTEGER,
  away_corners      INTEGER,
  momentum          TEXT,
  recorded_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_live_stats_fixture ON live_stats(fixture_id);

CREATE TABLE IF NOT EXISTS h2h (
  id            SERIAL PRIMARY KEY,
  home_team_id  INTEGER REFERENCES teams(id),
  away_team_id  INTEGER REFERENCES teams(id),
  fixture_id    INTEGER REFERENCES fixtures(id),
  match_date    TIMESTAMPTZ,
  home_goals    INTEGER,
  away_goals    INTEGER,
  result        TEXT,
  over05        BOOLEAN,
  over15        BOOLEAN,
  over25        BOOLEAN,
  gg            BOOLEAN,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS form_stats (
  id              SERIAL PRIMARY KEY,
  team_id         INTEGER REFERENCES teams(id),
  league_id       INTEGER REFERENCES leagues(id),
  fixture_id      INTEGER REFERENCES fixtures(id),
  match_date      TIMESTAMPTZ,
  is_home         BOOLEAN,
  goals_scored    INTEGER,
  goals_conceded  INTEGER,
  result          TEXT,
  over05          BOOLEAN,
  over15          BOOLEAN,
  over25          BOOLEAN,
  gg              BOOLEAN,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_form_stats_team ON form_stats(team_id);

CREATE TABLE IF NOT EXISTS injuries (
  id             SERIAL PRIMARY KEY,
  player_id      INTEGER REFERENCES players(id),
  team_id        INTEGER REFERENCES teams(id),
  league_id      INTEGER REFERENCES leagues(id),
  fixture_id     INTEGER,
  player_name    TEXT,
  injury_type    TEXT,
  injury_reason  TEXT,
  match_date     TIMESTAMPTZ,
  active         BOOLEAN DEFAULT true,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS odds (
  id              SERIAL PRIMARY KEY,
  fixture_id      INTEGER REFERENCES fixtures(id),
  bookmaker_id    INTEGER,
  bookmaker_name  TEXT,
  market          TEXT,
  label           TEXT,
  odd_value       NUMERIC(8,3),
  recorded_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_odds_fixture ON odds(fixture_id);

CREATE TABLE IF NOT EXISTS odds_history (
  id          SERIAL PRIMARY KEY,
  fixture_id  INTEGER REFERENCES fixtures(id),
  market      TEXT,
  label       TEXT,
  odd_value   NUMERIC(8,3),
  odd_open    NUMERIC(8,3),
  movement    TEXT,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prediction_results (
  id                  SERIAL PRIMARY KEY,
  prediction_id       INTEGER,
  fixture_id          INTEGER REFERENCES fixtures(id),
  market              TEXT,
  predicted_value     TEXT,
  actual_value        TEXT,
  is_correct          BOOLEAN,
  confidence_at_time  NUMERIC(5,4),
  odds_at_time        NUMERIC(8,3),
  ev_at_time          NUMERIC(8,4),
  resolved_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prediction_accuracy (
  id              SERIAL PRIMARY KEY,
  model_version   TEXT,
  market          TEXT,
  league_id       INTEGER,
  total           INTEGER DEFAULT 0,
  correct         INTEGER DEFAULT 0,
  accuracy        NUMERIC(5,4),
  avg_confidence  NUMERIC(5,4),
  roi             NUMERIC(8,4),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(model_version, market, league_id)
);

CREATE TABLE IF NOT EXISTS model_versions (
  id              SERIAL PRIMARY KEY,
  version         TEXT UNIQUE,
  description     TEXT,
  changes         TEXT,
  accuracy_over15 NUMERIC(5,4),
  accuracy_gg     NUMERIC(5,4),
  deployed_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS failed_predictions (
  id              SERIAL PRIMARY KEY,
  prediction_id   INTEGER,
  fixture_id      INTEGER,
  market          TEXT,
  failure_reason  TEXT,
  confidence      NUMERIC(5,4),
  actual_result   TEXT,
  analysis        TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS successful_patterns (
  id           SERIAL PRIMARY KEY,
  pattern_type TEXT,
  league_id    INTEGER,
  conditions   JSONB,
  sample_size  INTEGER DEFAULT 0,
  success_rate NUMERIC(5,4),
  avg_odds     NUMERIC(8,3),
  roi          NUMERIC(8,4),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS confidence_history (
  id            SERIAL PRIMARY KEY,
  fixture_id    INTEGER REFERENCES fixtures(id),
  prediction_id INTEGER,
  market        TEXT,
  confidence    NUMERIC(5,4),
  minute        INTEGER,
  recorded_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS raw_api_data (
  id          SERIAL PRIMARY KEY,
  endpoint    TEXT NOT NULL,
  fixture_id  INTEGER,
  league_id   INTEGER,
  params      JSONB,
  response    JSONB NOT NULL,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_raw_api_fixture ON raw_api_data(fixture_id);

CREATE TABLE IF NOT EXISTS alerts (
  id            SERIAL PRIMARY KEY,
  fixture_id    INTEGER REFERENCES fixtures(id),
  alert_type    TEXT,
  market        TEXT,
  message       TEXT,
  confidence    NUMERIC(5,4),
  odds          NUMERIC(8,3),
  sent_telegram BOOLEAN DEFAULT false,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- =====================
-- ALTER TABLE — tabele existente (nu strica datele)
-- =====================

ALTER TABLE predictions
  ADD COLUMN IF NOT EXISTS confidence_score  NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS prediction_reason TEXT,
  ADD COLUMN IF NOT EXISTS model_version     TEXT DEFAULT '1.0',
  ADD COLUMN IF NOT EXISTS home_win_prob     NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS draw_prob         NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS away_win_prob     NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS result_1x2        TEXT,
  ADD COLUMN IF NOT EXISTS outcome           TEXT;

ALTER TABLE predictions
  ALTER COLUMN recorded_at SET DEFAULT NOW();

ALTER TABLE player_stats
  ADD COLUMN IF NOT EXISTS position           TEXT,
  ADD COLUMN IF NOT EXISTS age                INTEGER,
  ADD COLUMN IF NOT EXISTS yellow_cards       INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS red_cards          INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS offsides           INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duels_total        INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duels_won          INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dribbles_attempts  INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dribbles_success   INTEGER DEFAULT 0;

-- =====================
-- INDEXES GLOBALE
-- =====================
CREATE INDEX IF NOT EXISTS idx_fixtures_date    ON fixtures(kickoff_time);
CREATE INDEX IF NOT EXISTS idx_fixtures_status  ON fixtures(status_short);
CREATE INDEX IF NOT EXISTS idx_fixtures_league  ON fixtures(league_id);
CREATE INDEX IF NOT EXISTS idx_match_stats_fixture ON match_stats(fixture_id);
CREATE INDEX IF NOT EXISTS idx_odds_fixture_market ON odds(fixture_id, market);
CREATE INDEX IF NOT EXISTS idx_cron_logs_ran    ON cron_logs(ran_at DESC);
