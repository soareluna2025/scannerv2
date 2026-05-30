-- ================================================================
--  AlohaScan — Create Tables
--  PostgreSQL database: elefant, user: alohascan
--  32 tables + 165 leagues insert
-- ================================================================

-- ── 1. fixtures ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fixtures (
    fixture_id      INTEGER PRIMARY KEY,
    league_id       INTEGER NOT NULL,
    season          INTEGER,
    round           TEXT,
    home_team_id    INTEGER,
    home_team_name  TEXT,
    away_team_id    INTEGER,
    away_team_name  TEXT,
    venue_id        INTEGER,
    venue_name      TEXT,
    venue_city      TEXT,
    status_short    TEXT,
    status_long     TEXT,
    match_date      TIMESTAMPTZ,
    home_goals      INTEGER,
    away_goals      INTEGER,
    home_ht         INTEGER,
    away_ht         INTEGER,
    referee         TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. match_stats ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS match_stats (
    id              SERIAL PRIMARY KEY,
    fixture_id      INTEGER NOT NULL,
    team_id         INTEGER NOT NULL,
    team_name       TEXT,
    shots_on_goal   INTEGER,
    shots_total     INTEGER,
    blocked_shots   INTEGER,
    shots_insidebox INTEGER,
    shots_outsidebox INTEGER,
    fouls           INTEGER,
    corner_kicks    INTEGER,
    offsides        INTEGER,
    ball_possession INTEGER,
    yellow_cards    INTEGER,
    red_cards       INTEGER,
    goalkeeper_saves INTEGER,
    total_passes    INTEGER,
    passes_accurate INTEGER,
    pass_percentage INTEGER,
    expected_goals  NUMERIC(5,2),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (fixture_id, team_id)
);

-- ── 3. match_events ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS match_events (
    id              SERIAL PRIMARY KEY,
    fixture_id      INTEGER NOT NULL,
    elapsed         INTEGER,
    elapsed_extra   INTEGER,
    team_id         INTEGER,
    team_name       TEXT,
    player_id       INTEGER,
    player_name     TEXT,
    assist_id       INTEGER,
    assist_name     TEXT,
    type            TEXT,
    detail          TEXT,
    comments        TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_match_events_fixture ON match_events(fixture_id);

-- ── 4. live_stats ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live_stats (
    id              SERIAL PRIMARY KEY,
    fixture_id      INTEGER NOT NULL,
    elapsed         INTEGER,
    home_goals      INTEGER,
    away_goals      INTEGER,
    home_sot        INTEGER,
    away_sot        INTEGER,
    home_shots      INTEGER,
    away_shots      INTEGER,
    home_possession INTEGER,
    away_possession INTEGER,
    home_corners    INTEGER,
    away_corners    INTEGER,
    home_da         INTEGER,
    away_da         INTEGER,
    home_xg         NUMERIC(5,2),
    away_xg         NUMERIC(5,2),
    ngp_home        NUMERIC(5,2),
    ngp_away        NUMERIC(5,2),
    recorded_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_live_stats_fixture ON live_stats(fixture_id);
CREATE INDEX IF NOT EXISTS idx_live_stats_recorded ON live_stats(recorded_at);

-- ── 5. fixtures_history ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fixtures_history (
    id              SERIAL PRIMARY KEY,
    fixture_id      INTEGER NOT NULL,
    league_id       INTEGER,
    season          INTEGER,
    home_team_id    INTEGER,
    home_team_name  TEXT,
    away_team_id    INTEGER,
    away_team_name  TEXT,
    home_goals      INTEGER,
    away_goals      INTEGER,
    home_ht         INTEGER,
    away_ht         INTEGER,
    status_short    TEXT,
    match_date      TIMESTAMPTZ,
    UNIQUE (fixture_id)
);

-- ── 6. teams ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teams (
    team_id         INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    code            TEXT,
    country         TEXT,
    founded         INTEGER,
    national        BOOLEAN DEFAULT FALSE,
    logo            TEXT,
    venue_id        INTEGER,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 7. teams_stats ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teams_stats (
    id              SERIAL PRIMARY KEY,
    team_id         INTEGER NOT NULL,
    league_id       INTEGER NOT NULL,
    season          INTEGER NOT NULL,
    form            TEXT,
    played_home     INTEGER,
    played_away     INTEGER,
    played_total    INTEGER,
    wins_home       INTEGER,
    wins_away       INTEGER,
    wins_total      INTEGER,
    draws_home      INTEGER,
    draws_away      INTEGER,
    draws_total     INTEGER,
    loses_home      INTEGER,
    loses_away      INTEGER,
    loses_total     INTEGER,
    goals_for_home  INTEGER,
    goals_for_away  INTEGER,
    goals_for_total INTEGER,
    goals_against_home  INTEGER,
    goals_against_away  INTEGER,
    goals_against_total INTEGER,
    avg_goals_for   NUMERIC(5,2),
    avg_goals_against NUMERIC(5,2),
    clean_sheets_home  INTEGER,
    clean_sheets_away  INTEGER,
    clean_sheets_total INTEGER,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (team_id, league_id, season)
);

-- ── 8. standings ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS standings (
    id              SERIAL PRIMARY KEY,
    league_id       INTEGER NOT NULL,
    season          INTEGER NOT NULL,
    rank            INTEGER,
    team_id         INTEGER NOT NULL,
    team_name       TEXT,
    team_logo       TEXT,
    points          INTEGER,
    goals_diff      INTEGER,
    group_name      TEXT,
    form            TEXT,
    status          TEXT,
    description     TEXT,
    played          INTEGER,
    win             INTEGER,
    draw            INTEGER,
    lose            INTEGER,
    goals_for       INTEGER,
    goals_against   INTEGER,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (league_id, season, team_id)
);

-- ── 9. form_stats ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS form_stats (
    id              SERIAL PRIMARY KEY,
    team_id         INTEGER NOT NULL,
    league_id       INTEGER NOT NULL,
    season          INTEGER NOT NULL,
    last5_home      TEXT,
    last5_away      TEXT,
    avg_scored_home NUMERIC(5,2),
    avg_conceded_home NUMERIC(5,2),
    avg_scored_away NUMERIC(5,2),
    avg_conceded_away NUMERIC(5,2),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (team_id, league_id, season)
);

-- ── 10. h2h ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS h2h (
    id              SERIAL PRIMARY KEY,
    team1_id        INTEGER NOT NULL,
    team2_id        INTEGER NOT NULL,
    fixture_id      INTEGER NOT NULL,
    home_team_id    INTEGER,
    away_team_id    INTEGER,
    home_goals      INTEGER,
    away_goals      INTEGER,
    match_date      TIMESTAMPTZ,
    league_id       INTEGER,
    season          INTEGER,
    UNIQUE (team1_id, team2_id, fixture_id)
);
CREATE INDEX IF NOT EXISTS idx_h2h_teams ON h2h(team1_id, team2_id);

-- ── 11. player_stats ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS player_stats (
    id              SERIAL PRIMARY KEY,
    player_id       INTEGER NOT NULL,
    fixture_id      INTEGER NOT NULL,
    team_id         INTEGER,
    team_name       TEXT,
    player_name     TEXT,
    position        TEXT,
    rating          NUMERIC(4,2),
    minutes_played  INTEGER,
    goals           INTEGER DEFAULT 0,
    assists         INTEGER DEFAULT 0,
    shots_total     INTEGER DEFAULT 0,
    shots_on_target INTEGER DEFAULT 0,
    pass_accuracy   NUMERIC(5,2),
    passes_total    INTEGER,
    key_passes      INTEGER,
    dribbles_success INTEGER,
    tackles         INTEGER,
    interceptions   INTEGER,
    yellow_cards    INTEGER DEFAULT 0,
    red_cards       INTEGER DEFAULT 0,
    player_score    NUMERIC(5,2),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (player_id, fixture_id)
);
CREATE INDEX IF NOT EXISTS idx_player_stats_team ON player_stats(team_id);
CREATE INDEX IF NOT EXISTS idx_player_stats_fixture ON player_stats(fixture_id);

-- ── 12. players_season ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS players_season (
    id              SERIAL PRIMARY KEY,
    player_id       INTEGER NOT NULL,
    team_id         INTEGER NOT NULL,
    league_id       INTEGER NOT NULL,
    season          INTEGER NOT NULL,
    player_name     TEXT,
    nationality     TEXT,
    position        TEXT,
    age             INTEGER,
    appearances     INTEGER DEFAULT 0,
    lineups         INTEGER DEFAULT 0,
    minutes         INTEGER DEFAULT 0,
    goals           INTEGER DEFAULT 0,
    assists         INTEGER DEFAULT 0,
    yellow_cards    INTEGER DEFAULT 0,
    red_cards       INTEGER DEFAULT 0,
    rating          NUMERIC(4,2),
    pass_accuracy   NUMERIC(5,2),
    shots_on_target INTEGER,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (player_id, league_id, season)
);

-- ── 13. squads ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS squads (
    id              SERIAL PRIMARY KEY,
    team_id         INTEGER NOT NULL,
    season          INTEGER NOT NULL,
    player_id       INTEGER NOT NULL,
    player_name     TEXT,
    number          INTEGER,
    position        TEXT,
    age             INTEGER,
    photo           TEXT,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (team_id, season, player_id)
);

-- ── 14. injuries ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS injuries (
    id              SERIAL PRIMARY KEY,
    fixture_id      INTEGER NOT NULL,
    league_id       INTEGER,
    season          INTEGER,
    team_id         INTEGER,
    team_name       TEXT,
    player_id       INTEGER,
    player_name     TEXT,
    type            TEXT,
    reason          TEXT,
    match_date      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (fixture_id, player_id)
);

-- ── 15. sidelined ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sidelined (
    id              SERIAL PRIMARY KEY,
    player_id       INTEGER NOT NULL,
    type            TEXT,
    start_date      DATE,
    end_date        DATE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 16. coaches ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coaches (
    id              SERIAL PRIMARY KEY,
    coach_id        INTEGER NOT NULL,
    team_id         INTEGER,
    team_name       TEXT,
    name            TEXT,
    firstname       TEXT,
    lastname        TEXT,
    nationality     TEXT,
    age             INTEGER,
    career_start    DATE,
    career_end      DATE,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (coach_id, team_id)
);

-- ── 16b. coach_career ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coach_career (
    id           SERIAL PRIMARY KEY,
    coach_id     INT NOT NULL,
    team_id      INT,
    team_name    TEXT,
    start_date   DATE,
    end_date     DATE,
    UNIQUE (coach_id, team_id, start_date)
);
CREATE INDEX IF NOT EXISTS idx_coach_career_coach ON coach_career(coach_id);

-- ── 16c. coach_stats ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coach_stats (
    coach_id             INT PRIMARY KEY,
    coach_name           TEXT,
    matches              INT DEFAULT 0,
    wins                 INT DEFAULT 0,
    draws                INT DEFAULT 0,
    losses               INT DEFAULT 0,
    win_rate             NUMERIC(5,2),
    avg_goals_for        NUMERIC(4,2),
    avg_goals_against    NUMERIC(4,2),
    clean_sheet_rate     NUMERIC(5,2),
    failed_to_score_rate NUMERIC(5,2),
    style                TEXT,
    tenure_days          INT,
    current_team_id      INT,
    last_match_date      TIMESTAMPTZ,
    updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- ── 17. transfers ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transfers (
    id              SERIAL PRIMARY KEY,
    player_id       INTEGER NOT NULL,
    player_name     TEXT,
    team_in_id      INTEGER,
    team_in_name    TEXT,
    team_out_id     INTEGER,
    team_out_name   TEXT,
    transfer_date   DATE,
    type            TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 18. venues ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS venues (
    venue_id        INTEGER PRIMARY KEY,
    name            TEXT,
    address         TEXT,
    city            TEXT,
    country         TEXT,
    capacity        INTEGER,
    surface         TEXT,
    image           TEXT,
    latitude        NUMERIC(9,6),
    longitude       NUMERIC(9,6),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 19. odds ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS odds (
    id              SERIAL PRIMARY KEY,
    fixture_id      INTEGER NOT NULL,
    bookmaker_id    INTEGER,
    bookmaker_name  TEXT,
    bet_id          INTEGER,
    bet_name        TEXT,
    value_name      TEXT,
    value_odd       NUMERIC(8,3),
    collected_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (fixture_id, bookmaker_id, bet_id, value_name)
);
CREATE INDEX IF NOT EXISTS idx_odds_fixture ON odds(fixture_id);

-- ── 20. live_odds ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live_odds (
    id              SERIAL PRIMARY KEY,
    fixture_id      INTEGER NOT NULL,
    elapsed         INTEGER,
    bookmaker_id    INTEGER,
    bet_id          INTEGER,
    value_name      TEXT,
    value_odd       NUMERIC(8,3),
    recorded_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_live_odds_fixture ON live_odds(fixture_id);

-- ── 21. predictions ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS predictions (
    id              SERIAL PRIMARY KEY,
    fixture_id      INTEGER NOT NULL UNIQUE,
    home_team       TEXT,
    away_team       TEXT,
    league_name     TEXT,
    league_id       INTEGER,
    match_date      TIMESTAMPTZ,
    lambda_home     NUMERIC(6,3),
    lambda_away     NUMERIC(6,3),
    lambda_total    NUMERIC(6,3),
    over15_prob     NUMERIC(5,2),
    over25_prob     NUMERIC(5,2),
    gg_prob         NUMERIC(5,2),
    home_win_prob   NUMERIC(5,2),
    draw_prob       NUMERIC(5,2),
    away_win_prob   NUMERIC(5,2),
    home_score_rate NUMERIC(5,2),
    away_score_rate NUMERIC(5,2),
    h2h_over15      NUMERIC(5,2),
    confidence      NUMERIC(5,2),
    best_ev         NUMERIC(6,3),
    best_cota       NUMERIC(8,3),
    best_bet        TEXT,
    result_over15   BOOLEAN,
    result_over25   BOOLEAN,
    result_gg       BOOLEAN,
    result_1x2      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 22. alerts ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alerts (
    id              SERIAL PRIMARY KEY,
    fixture_id      INTEGER NOT NULL,
    alert_type      TEXT NOT NULL,
    message         TEXT,
    ngp_value       NUMERIC(5,2),
    threshold       NUMERIC(5,2),
    sent_at         TIMESTAMPTZ DEFAULT NOW(),
    telegram_ok     BOOLEAN DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_alerts_fixture ON alerts(fixture_id);
CREATE INDEX IF NOT EXISTS idx_alerts_sent ON alerts(sent_at);

-- ── 23. pre_match_snapshots ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS pre_match_snapshots (
    id              SERIAL PRIMARY KEY,
    fixture_id      INTEGER NOT NULL UNIQUE,
    home_team_id    INTEGER,
    away_team_id    INTEGER,
    home_form       TEXT,
    away_form       TEXT,
    home_avg_scored NUMERIC(5,2),
    home_avg_conceded NUMERIC(5,2),
    away_avg_scored NUMERIC(5,2),
    away_avg_conceded NUMERIC(5,2),
    h2h_summary     JSONB,
    lambda_home     NUMERIC(6,3),
    lambda_away     NUMERIC(6,3),
    over15_prob     NUMERIC(5,2),
    over25_prob     NUMERIC(5,2),
    gg_prob         NUMERIC(5,2),
    confidence      NUMERIC(5,2),
    odds_snapshot   JSONB,
    weather         JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 24. top_scorers ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS top_scorers (
    id              SERIAL PRIMARY KEY,
    league_id       INTEGER NOT NULL,
    season          INTEGER NOT NULL,
    player_id       INTEGER NOT NULL,
    player_name     TEXT,
    team_id         INTEGER,
    team_name       TEXT,
    goals           INTEGER DEFAULT 0,
    assists         INTEGER DEFAULT 0,
    penalties       INTEGER DEFAULT 0,
    appearances     INTEGER DEFAULT 0,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (league_id, season, player_id)
);

-- ── 25. top_assists ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS top_assists (
    id              SERIAL PRIMARY KEY,
    league_id       INTEGER NOT NULL,
    season          INTEGER NOT NULL,
    player_id       INTEGER NOT NULL,
    player_name     TEXT,
    team_id         INTEGER,
    team_name       TEXT,
    assists         INTEGER DEFAULT 0,
    goals           INTEGER DEFAULT 0,
    appearances     INTEGER DEFAULT 0,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (league_id, season, player_id)
);

-- ── 26. leagues ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leagues (
    league_id       INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    country         TEXT,
    tier            INTEGER,
    timezone        TEXT,
    active_hours_start INTEGER,
    active_hours_end   INTEGER,
    active            BOOLEAN DEFAULT TRUE,
    logo              TEXT,
    flag              TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── 27. bookmakers ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookmakers (
    bookmaker_id    INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    active          BOOLEAN DEFAULT TRUE
);

-- ── 28. bets ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bets (
    bet_id          INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT
);

-- ── 29. trophies ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trophies (
    id              SERIAL PRIMARY KEY,
    team_id         INTEGER NOT NULL,
    league_id       INTEGER,
    league_name     TEXT,
    country         TEXT,
    season          TEXT,
    place           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 30. fixture_status_log ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS fixture_status_log (
    id              SERIAL PRIMARY KEY,
    fixture_id      INTEGER NOT NULL,
    status_short    TEXT,
    status_long     TEXT,
    elapsed         INTEGER,
    home_goals      INTEGER,
    away_goals      INTEGER,
    recorded_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fixture_status_fixture ON fixture_status_log(fixture_id);

-- ── 31. cron_logs ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cron_logs (
    id              SERIAL PRIMARY KEY,
    job_name        TEXT NOT NULL,
    ran_at          TIMESTAMPTZ DEFAULT NOW(),
    fixtures_processed INTEGER DEFAULT 0,
    players_upserted   INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'ok',
    error_msg       TEXT,
    duration_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cron_logs_job ON cron_logs(job_name, ran_at DESC);

-- ── 32. backfill_progress ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backfill_progress (
    league_id       INTEGER PRIMARY KEY,
    status          TEXT DEFAULT 'pending',
    fixtures_processed INTEGER DEFAULT 0,
    players_upserted   INTEGER DEFAULT 0,
    last_run        TIMESTAMPTZ,
    error_msg       TEXT
);

-- ================================================================
--  INSERT 165 LEAGUES
-- ================================================================
INSERT INTO leagues (league_id, name, country, tier, timezone, active_hours_start, active_hours_end) VALUES
-- ── TIER 1 — Europa top 5 + UCL/UEL ─────────────────────────────
(2,   'UEFA Champions League',      'Europe',      1, 'Europe/Brussels',   17, 23),
(3,   'UEFA Europa League',         'Europe',      1, 'Europe/Brussels',   17, 23),
(848, 'UEFA Conference League',     'Europe',      1, 'Europe/Brussels',   17, 23),
(39,  'Premier League',             'England',     1, 'Europe/London',     14, 22),
(140, 'La Liga',                    'Spain',       1, 'Europe/Madrid',     18, 23),
(78,  'Bundesliga',                 'Germany',     1, 'Europe/Berlin',     15, 22),
(135, 'Serie A',                    'Italy',       1, 'Europe/Rome',       18, 23),
(61,  'Ligue 1',                    'France',      1, 'Europe/Paris',      18, 23),
(88,  'Eredivisie',                 'Netherlands', 1, 'Europe/Amsterdam',  18, 23),
(94,  'Primeira Liga',              'Portugal',    1, 'Europe/Lisbon',     18, 23),
(203, 'Super Lig',                  'Turkey',      1, 'Europe/Istanbul',   17, 23),
(144, 'Pro League',                 'Belgium',     1, 'Europe/Brussels',   18, 23),
(179, 'Premiership',                'Scotland',    1, 'Europe/London',     14, 22),
(71,  'Serie A',                    'Brazil',      1, 'America/Sao_Paulo', 19, 2),
(128, 'Primera Division',           'Argentina',   1, 'America/Argentina/Buenos_Aires', 19, 2),
(253, 'MLS',                        'USA',         1, 'America/New_York',  19, 2),
(307, 'Saudi Pro League',           'Saudi Arabia',1, 'Asia/Riyadh',       17, 22),
(98,  'J1 League',                  'Japan',       1, 'Asia/Tokyo',        9,  16),
(292, 'K League 1',                 'South Korea', 1, 'Asia/Seoul',        9,  16),
(169, 'Super League',               'China',       1, 'Asia/Shanghai',     9,  15),
(233, 'Premier League',             'Egypt',       1, 'Africa/Cairo',      18, 23),
(200, 'Botola Pro',                 'Morocco',     1, 'Africa/Casablanca', 17, 23),
(288, 'Premier Division',           'South Africa',1, 'Africa/Johannesburg',17,23),
(13,  'Copa Libertadores',          'South America',1,'America/Sao_Paulo', 19, 2),
(11,  'Copa Sudamericana',          'South America',1,'America/Sao_Paulo', 19, 2),
(1,   'World Cup',                  'World',       1, 'UTC',               12, 23),
(4,   'Euro Championship',          'Europe',      1, 'Europe/Brussels',   14, 23),
(9,   'Copa America',               'South America',1,'America/Sao_Paulo', 18, 2),
(10,  'CONCACAF Champions Cup',     'CONCACAF',    1, 'America/New_York',  19, 2),
(17,  'AFC Champions League',       'Asia',        1, 'Asia/Riyadh',       15, 22),
(12,  'CAF Champions League',       'Africa',      1, 'Africa/Cairo',      17, 23),
(5,   'UEFA Nations League',        'Europe',      1, 'Europe/Brussels',   17, 23),
(6,   'FIFA Club World Cup',        'World',       1, 'UTC',               14, 23),
(26,  'CONCACAF Nations League',    'CONCACAF',    1, 'America/New_York',  19, 2),
(19,  'Qatar Stars League',         'Qatar',       1, 'Asia/Qatar',        17, 22),
(290, 'Persian Gulf Pro League',    'Iran',        1, 'Asia/Tehran',       17, 22),
(262, 'Liga MX',                    'Mexico',      1, 'America/Mexico_City',19,2),
-- ── TIER 2 — Liga 1 + Cupe Europa ────────────────────────────────
(40,  'Championship',               'England',     2, 'Europe/London',     14, 22),
(45,  'FA Cup',                     'England',     2, 'Europe/London',     14, 22),
(48,  'EFL Cup',                    'England',     2, 'Europe/London',     14, 22),
(141, 'Segunda Division',           'Spain',       2, 'Europe/Madrid',     18, 23),
(143, 'Copa del Rey',               'Spain',       2, 'Europe/Madrid',     18, 23),
(79,  '2. Bundesliga',              'Germany',     2, 'Europe/Berlin',     15, 22),
(81,  'DFB Pokal',                  'Germany',     2, 'Europe/Berlin',     15, 22),
(136, 'Serie B',                    'Italy',       2, 'Europe/Rome',       18, 23),
(137, 'Coppa Italia',               'Italy',       2, 'Europe/Rome',       18, 23),
(62,  'Ligue 2',                    'France',      2, 'Europe/Paris',      18, 23),
(66,  'Coupe de France',            'France',      2, 'Europe/Paris',      18, 23),
(89,  'Eerste Divisie',             'Netherlands', 2, 'Europe/Amsterdam',  18, 23),
(90,  'KNVB Cup',                   'Netherlands', 2, 'Europe/Amsterdam',  18, 23),
(95,  'Liga Portugal 2',            'Portugal',    2, 'Europe/Lisbon',     18, 23),
(96,  'Taca de Portugal',           'Portugal',    2, 'Europe/Lisbon',     18, 23),
(145, 'Challenger Pro League',      'Belgium',     2, 'Europe/Brussels',   18, 23),
(146, 'Belgian Cup',                'Belgium',     2, 'Europe/Brussels',   18, 23),
(204, 'TFF First League',           'Turkey',      2, 'Europe/Istanbul',   17, 23),
(205, 'Turkish Cup',                'Turkey',      2, 'Europe/Istanbul',   17, 23),
(180, 'Championship',               'Scotland',    2, 'Europe/London',     14, 22),
(184, 'Scottish Cup',               'Scotland',    2, 'Europe/London',     14, 22),
(207, 'Super League',               'Switzerland', 2, 'Europe/Zurich',     18, 23),
(208, 'Challenge League',           'Switzerland', 2, 'Europe/Zurich',     18, 23),
(209, 'Swiss Cup',                  'Switzerland', 2, 'Europe/Zurich',     18, 23),
(218, 'Bundesliga',                 'Austria',     2, 'Europe/Vienna',     18, 23),
(219, '2. Liga',                    'Austria',     2, 'Europe/Vienna',     18, 23),
(221, 'OFB Cup',                    'Austria',     2, 'Europe/Vienna',     18, 23),
(119, 'Superliga',                  'Denmark',     2, 'Europe/Copenhagen', 17, 23),
(120, '1st Division',               'Denmark',     2, 'Europe/Copenhagen', 17, 23),
(123, 'DBU Pokalen',                'Denmark',     2, 'Europe/Copenhagen', 17, 23),
(103, 'Eliteserien',                'Norway',      2, 'Europe/Oslo',       16, 22),
(104, 'First Division',             'Norway',      2, 'Europe/Oslo',       16, 22),
(105, 'Norwegian Cup',              'Norway',      2, 'Europe/Oslo',       16, 22),
(113, 'Allsvenskan',                'Sweden',      2, 'Europe/Stockholm',  16, 22),
(114, 'Superettan',                 'Sweden',      2, 'Europe/Stockholm',  16, 22),
(115, 'Svenska Cupen',              'Sweden',      2, 'Europe/Stockholm',  16, 22),
(106, 'Ekstraklasa',                'Poland',      2, 'Europe/Warsaw',     17, 23),
(107, 'I Liga',                     'Poland',      2, 'Europe/Warsaw',     17, 23),
(108, 'Polish Cup',                 'Poland',      2, 'Europe/Warsaw',     17, 23),
(345, 'Fortuna Liga',               'Czech Republic',2,'Europe/Prague',    17, 23),
(346, 'FNL',                        'Czech Republic',2,'Europe/Prague',    17, 23),
(347, 'MOL Cup',                    'Czech Republic',2,'Europe/Prague',    17, 23),
(210, 'Prva HNL',                   'Croatia',     2, 'Europe/Zagreb',     17, 23),
(211, 'Druga HNL',                  'Croatia',     2, 'Europe/Zagreb',     17, 23),
(212, 'Croatian Cup',               'Croatia',     2, 'Europe/Zagreb',     17, 23),
(392, 'SuperLiga',                  'Serbia',      2, 'Europe/Belgrade',   17, 23),
(393, 'Prva Liga',                  'Serbia',      2, 'Europe/Belgrade',   17, 23),
(394, 'Kup Srbije',                 'Serbia',      2, 'Europe/Belgrade',   17, 23),
(783, 'Superliga',                  'Romania',     2, 'Europe/Bucharest',  17, 23),
(785, 'Liga II',                    'Romania',     2, 'Europe/Bucharest',  17, 23),
(787, 'Cupa Romaniei',              'Romania',     2, 'Europe/Bucharest',  17, 23),
(551, 'Super League 1',             'Greece',      2, 'Europe/Athens',     17, 23),
(552, 'Super League 2',             'Greece',      2, 'Europe/Athens',     17, 23),
(556, 'Greek Cup',                  'Greece',      2, 'Europe/Athens',     17, 23),
(271, 'Nemzeti Bajnoksag I',        'Hungary',     2, 'Europe/Budapest',   17, 23),
(272, 'Nemzeti Bajnoksag II',       'Hungary',     2, 'Europe/Budapest',   17, 23),
(275, 'Magyar Kupa',                'Hungary',     2, 'Europe/Budapest',   17, 23),
(72,  'Serie B',                    'Brazil',      2, 'America/Sao_Paulo', 19, 2),
(73,  'Copa do Brasil',             'Brazil',      2, 'America/Sao_Paulo', 19, 2),
(131, 'Primera Nacional',           'Argentina',   2, 'America/Argentina/Buenos_Aires',19,2),
(132, 'Copa Argentina',             'Argentina',   2, 'America/Argentina/Buenos_Aires',19,2),
(263, 'Liga Expansion',             'Mexico',      2, 'America/Mexico_City',19,2),
(264, 'Copa MX',                    'Mexico',      2, 'America/Mexico_City',19,2),
(239, 'Primera A',                  'Colombia',    2, 'America/Bogota',    19, 2),
(240, 'Primera B',                  'Colombia',    2, 'America/Bogota',    19, 2),
(241, 'Copa Colombia',              'Colombia',    2, 'America/Bogota',    19, 2),
(308, 'First Division',             'Saudi Arabia',2, 'Asia/Riyadh',       17, 22),
(313, 'King Cup',                   'Saudi Arabia',2, 'Asia/Riyadh',       17, 22),
(99,  'J2 League',                  'Japan',       2, 'Asia/Tokyo',        9,  16),
(100, 'Emperors Cup',               'Japan',       2, 'Asia/Tokyo',        9,  16),
(293, 'K League 2',                 'South Korea', 2, 'Asia/Seoul',        9,  16),
(294, 'Korean FA Cup',              'South Korea', 2, 'Asia/Seoul',        9,  16),
(18,  'AFC Cup',                    'Asia',        2, 'Asia/Riyadh',       15, 22),
(20,  'CAF Confederation Cup',      'Africa',      2, 'Africa/Cairo',      17, 23),
-- ── TIER 3 — Liga 2 restante + ligi mid ──────────────────────────
(172, 'First Professional League',  'Bulgaria',    3, 'Europe/Sofia',      17, 23),
(173, 'Second Professional League', 'Bulgaria',    3, 'Europe/Sofia',      17, 23),
(174, 'Bulgarian Cup',              'Bulgaria',    3, 'Europe/Sofia',      17, 23),
(332, 'Super Liga',                 'Slovakia',    3, 'Europe/Bratislava', 17, 23),
(506, '2. liga',                    'Slovakia',    3, 'Europe/Bratislava', 17, 23),
(680, 'Slovak Cup',                 'Slovakia',    3, 'Europe/Bratislava', 17, 23),
(244, 'Veikkausliiga',              'Finland',     3, 'Europe/Helsinki',   14, 21),
(245, 'Ykkonen',                    'Finland',     3, 'Europe/Helsinki',   14, 21),
(246, 'Finnish Cup',                'Finland',     3, 'Europe/Helsinki',   14, 21),
(333, 'Premier League',             'Ukraine',     3, 'Europe/Kiev',       17, 23),
(334, 'Persha Liha',                'Ukraine',     3, 'Europe/Kiev',       17, 23),
(336, 'Ukrainian Cup',              'Ukraine',     3, 'Europe/Kiev',       17, 23),
(235, 'Premier League',             'Russia',      3, 'Europe/Moscow',     16, 22),
(236, 'First League',               'Russia',      3, 'Europe/Moscow',     16, 22),
(237, 'Russian Cup',                'Russia',      3, 'Europe/Moscow',     16, 22),
(116, 'Vysheyshaya Liga',           'Belarus',     3, 'Europe/Minsk',      16, 22),
(117, '1. Division',                'Belarus',     3, 'Europe/Minsk',      16, 22),
(486, 'Belarusian Cup',             'Belarus',     3, 'Europe/Minsk',      16, 22),
(389, 'Premier League',             'Kazakhstan',  3, 'Asia/Almaty',       13, 20),
(388, '1. Division',                'Kazakhstan',  3, 'Asia/Almaty',       13, 20),
(498, 'Kazakhstan Cup',             'Kazakhstan',  3, 'Asia/Almaty',       13, 20),
(265, 'Primera Division',           'Chile',       3, 'America/Santiago',  20, 2),
(266, 'Primera B',                  'Chile',       3, 'America/Santiago',  20, 2),
(267, 'Copa Chile',                 'Chile',       3, 'America/Santiago',  20, 2),
(268, 'Primera Division',           'Uruguay',     3, 'America/Montevideo',19, 2),
(269, 'Segunda Division',           'Uruguay',     3, 'America/Montevideo',19, 2),
(270, 'Copa Uruguay',               'Uruguay',     3, 'America/Montevideo',19, 2),
(281, 'Liga 1',                     'Peru',        3, 'America/Lima',      19, 2),
(282, 'Liga 2',                     'Peru',        3, 'America/Lima',      19, 2),
(283, 'Copa Peru',                  'Peru',        3, 'America/Lima',      19, 2),
(286, 'LigaPro Serie A',            'Ecuador',     3, 'America/Guayaquil', 19, 2),
(287, 'LigaPro Serie B',            'Ecuador',     3, 'America/Guayaquil', 19, 2),
(735, 'Copa Ecuador',               'Ecuador',     3, 'America/Guayaquil', 19, 2),
(278, 'Primera Division',           'Paraguay',    3, 'America/Asuncion',  19, 2),
(279, 'Division Intermedia',        'Paraguay',    3, 'America/Asuncion',  19, 2),
(280, 'Copa Paraguay',              'Paraguay',    3, 'America/Asuncion',  19, 2),
(273, 'Primera Division',           'Bolivia',     3, 'America/La_Paz',    19, 2),
(274, 'Liga de Ascenso',            'Bolivia',     3, 'America/La_Paz',    19, 2),
(276, 'Copa Bolivia',               'Bolivia',     3, 'America/La_Paz',    19, 2),
(153, 'Liga FUTVE',                 'Venezuela',   3, 'America/Caracas',   19, 2),
(154, 'Segunda Division',           'Venezuela',   3, 'America/Caracas',   19, 2),
(155, 'Copa Venezuela',             'Venezuela',   3, 'America/Caracas',   19, 2),
(255, 'USL Championship',           'USA',         3, 'America/New_York',  19, 2),
(257, 'US Open Cup',                'USA',         3, 'America/New_York',  19, 2),
(909, 'MLS Next Pro',               'USA',         3, 'America/New_York',  19, 2),
(321, 'Canadian Premier League',    'Canada',      3, 'America/Toronto',   19, 2),
(322, 'Canadian Championship',      'Canada',      3, 'America/Toronto',   19, 2),
(258, 'Primera Division',           'Costa Rica',  3, 'America/Costa_Rica',19, 2),
(259, 'Segunda Division',           'Costa Rica',  3, 'America/Costa_Rica',19, 2),
(260, 'Copa Costa Rica',            'Costa Rica',  3, 'America/Costa_Rica',19, 2),
(261, 'Liga Nacional',              'Honduras',    3, 'America/Tegucigalpa',19,2),
(319, 'Liga de Ascenso',            'Honduras',    3, 'America/Tegucigalpa',19,2),
(320, 'Copa Honduras',              'Honduras',    3, 'America/Tegucigalpa',19,2),
(339, 'Liga Nacional',              'Guatemala',   3, 'America/Guatemala', 19, 2),
(338, 'Primera Division',           'Guatemala',   3, 'America/Guatemala', 19, 2),
(248, 'Copa Guatemala',             'Guatemala',   3, 'America/Guatemala', 19, 2),
(344, 'Primera Division',           'El Salvador', 3, 'America/El_Salvador',19,2),
(349, 'Segunda Division',           'El Salvador', 3, 'America/El_Salvador',19,2),
(350, 'Copa El Salvador',           'El Salvador', 3, 'America/El_Salvador',19,2),
(256, 'Primera Division',           'Nicaragua',   3, 'America/Managua',   19, 2),
(380, 'Segunda Division',           'Nicaragua',   3, 'America/Managua',   19, 2),
(713, 'Superliga',                  'Colombia',    3, 'America/Bogota',    19, 2),
(291, 'Azadegan League',            'Iran',        3, 'Asia/Tehran',       17, 22),
(295, 'Hazfi Cup',                  'Iran',        3, 'Asia/Tehran',       17, 22),
(21,  'QSL',                        'Qatar',       3, 'Asia/Qatar',        17, 22),
(22,  'Emir Cup',                   'Qatar',       3, 'Asia/Qatar',        17, 22),
(433, 'Pro League',                 'UAE',         3, 'Asia/Dubai',        17, 22),
(434, 'First Division',             'UAE',         3, 'Asia/Dubai',        17, 22),
(435, 'UAE Cup',                    'UAE',         3, 'Asia/Dubai',        17, 22),
(170, 'League One',                 'China',       3, 'Asia/Shanghai',     9,  15),
(171, 'FA Cup',                     'China',       3, 'Asia/Shanghai',     9,  15),
(296, 'Thai League 1',              'Thailand',    3, 'Asia/Bangkok',      11, 18),
(297, 'Thai League 2',              'Thailand',    3, 'Asia/Bangkok',      11, 18),
(298, 'Thai FA Cup',                'Thailand',    3, 'Asia/Bangkok',      11, 18),
(335, 'Super League',               'Uzbekistan',  3, 'Asia/Tashkent',     14, 21),
(631, 'Pro League',                 'Uzbekistan',  3, 'Asia/Tashkent',     14, 21),
(632, 'Uzbek Cup',                  'Uzbekistan',  3, 'Asia/Tashkent',     14, 21),
(188, 'A-League Men',               'Australia',   3, 'Australia/Sydney',  7,  14),
(189, 'Australia Cup',              'Australia',   3, 'Australia/Sydney',  7,  14),
(323, 'ISL',                        'India',       3, 'Asia/Kolkata',      11, 18),
(324, 'I-League',                   'India',       3, 'Asia/Kolkata',      11, 18),
(325, 'Durand Cup',                 'India',       3, 'Asia/Kolkata',      11, 18),
(518, 'Super League',               'Malaysia',    3, 'Asia/Kuala_Lumpur', 11, 18),
(519, 'Premier League',             'Malaysia',    3, 'Asia/Kuala_Lumpur', 11, 18),
(520, 'Malaysia Cup',               'Malaysia',    3, 'Asia/Kuala_Lumpur', 11, 18),
(391, 'Liga 1',                     'Indonesia',   3, 'Asia/Jakarta',      11, 18),
(460, 'Liga 2',                     'Indonesia',   3, 'Asia/Jakarta',      11, 18),
(461, 'Indonesian Cup',             'Indonesia',   3, 'Asia/Jakarta',      11, 18),
(340, 'V.League 1',                 'Vietnam',     3, 'Asia/Ho_Chi_Minh',  11, 18),
(341, 'V.League 2',                 'Vietnam',     3, 'Asia/Ho_Chi_Minh',  11, 18),
(342, 'Vietnamese Cup',             'Vietnam',     3, 'Asia/Ho_Chi_Minh',  11, 18),
(302, 'Premier League',             'Iraq',        3, 'Asia/Baghdad',      17, 22),
(303, 'Division 1',                 'Iraq',        3, 'Asia/Baghdad',      17, 22),
(304, 'Iraqi Cup',                  'Iraq',        3, 'Asia/Baghdad',      17, 22),
(474, 'Pro League',                 'Jordan',      3, 'Asia/Amman',        17, 22),
(475, 'Division 1',                 'Jordan',      3, 'Asia/Amman',        17, 22),
(494, 'Jordan Cup',                 'Jordan',      3, 'Asia/Amman',        17, 22),
(299, 'Premier League',             'Kuwait',      3, 'Asia/Kuwait',       17, 22),
(300, 'Division 1',                 'Kuwait',      3, 'Asia/Kuwait',       17, 22),
(493, 'Emir Cup',                   'Kuwait',      3, 'Asia/Kuwait',       17, 22),
(309, 'Professional League',        'Oman',        3, 'Asia/Muscat',       17, 22),
(491, 'Division 1',                 'Oman',        3, 'Asia/Muscat',       17, 22),
(492, 'Sultan Qaboos Cup',          'Oman',        3, 'Asia/Muscat',       17, 22),
(499, 'Premier League',             'Hong Kong',   3, 'Asia/Hong_Kong',    9,  16),
(500, 'First Division',             'Hong Kong',   3, 'Asia/Hong_Kong',    9,  16),
(503, 'HK FA Cup',                  'Hong Kong',   3, 'Asia/Hong_Kong',    9,  16),
(502, 'Premier League',             'Singapore',   3, 'Asia/Singapore',    11, 18),
(234, 'Second Division',            'Egypt',       3, 'Africa/Cairo',      18, 23),
(238, 'Egyptian Cup',               'Egypt',       3, 'Africa/Cairo',      18, 23),
(201, 'Botola 2',                   'Morocco',     3, 'Africa/Casablanca', 17, 23),
(822, 'Coupe du Trone',             'Morocco',     3, 'Africa/Casablanca', 17, 23),
(202, 'Ligue 1',                    'Tunisia',     3, 'Africa/Tunis',      17, 23),
(377, 'Ligue 2',                    'Tunisia',     3, 'Africa/Tunis',      17, 23),
(378, 'Coupe de Tunisie',           'Tunisia',     3, 'Africa/Tunis',      17, 23),
(197, 'Ligue Professionnelle 1',    'Algeria',     3, 'Africa/Algiers',    17, 23),
(198, 'Ligue Professionnelle 2',    'Algeria',     3, 'Africa/Algiers',    17, 23),
(199, 'Coupe dAlgerie',             'Algeria',     3, 'Africa/Algiers',    17, 23),
(670, 'National First Division',    'South Africa',3, 'Africa/Johannesburg',17,23),
(671, 'Nedbank Cup',                'South Africa',3, 'Africa/Johannesburg',17,23),
(399, 'NPFL',                       'Nigeria',     3, 'Africa/Lagos',      17, 22),
(666, 'Nigeria National League',    'Nigeria',     3, 'Africa/Lagos',      17, 22),
(667, 'Nigerian FA Cup',            'Nigeria',     3, 'Africa/Lagos',      17, 22),
(289, 'Premier League',             'Ghana',       3, 'Africa/Accra',      17, 22),
(417, 'Division One',               'Ghana',       3, 'Africa/Accra',      17, 22),
(418, 'Ghana FA Cup',               'Ghana',       3, 'Africa/Accra',      17, 22),
(383, 'Ligue 1',                    'Ivory Coast', 3, 'Africa/Abidjan',    17, 22),
(384, 'Ligue 2',                    'Ivory Coast', 3, 'Africa/Abidjan',    17, 22),
(385, 'Coupe de Cote dIvoire',      'Ivory Coast', 3, 'Africa/Abidjan',    17, 22),
(357, 'Premier League',             'Kenya',       3, 'Africa/Nairobi',    17, 22),
(358, 'National Super League',      'Kenya',       3, 'Africa/Nairobi',    17, 22)
ON CONFLICT (league_id) DO UPDATE SET
    name = EXCLUDED.name,
    country = EXCLUDED.country,
    tier = EXCLUDED.tier,
    timezone = EXCLUDED.timezone,
    active_hours_start = EXCLUDED.active_hours_start,
    active_hours_end = EXCLUDED.active_hours_end,
    updated_at = NOW();

-- ── 33. prematch_enrichment_log ─────────────────────────────────
CREATE TABLE IF NOT EXISTS prematch_enrichment_log (
    fixture_id  INTEGER NOT NULL,
    stage       INTEGER NOT NULL,
    executed_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (fixture_id, stage)
);

-- ── 34. prematch_data ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prematch_data (
    fixture_id   INTEGER NOT NULL,
    stage        INTEGER NOT NULL,
    data_type    VARCHAR(50) NOT NULL,
    payload      JSONB,
    collected_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (fixture_id, stage, data_type)
);
CREATE INDEX IF NOT EXISTS idx_prematch_data_fixture ON prematch_data(fixture_id);

-- ── 35. referee_stats ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referee_stats (
    referee_name      VARCHAR(200) PRIMARY KEY,
    total_matches     INTEGER DEFAULT 0,
    avg_yellow_cards  DECIMAL(4,2) DEFAULT 0,
    avg_red_cards     DECIMAL(4,2) DEFAULT 0,
    avg_penalties     DECIMAL(4,2) DEFAULT 0,
    avg_fouls         DECIMAL(4,2) DEFAULT 0,
    avg_corners       DECIMAL(4,2) DEFAULT 0,
    avg_goals         DECIMAL(4,2) DEFAULT 0,
    pct_over_25       DECIMAL(5,2) DEFAULT 0,
    pct_gg            DECIMAL(5,2) DEFAULT 0,
    pct_btts          DECIMAL(5,2) DEFAULT 0,
    referee_style     VARCHAR(20) DEFAULT 'neutral',
    updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── 36. league_stats ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS league_stats (
    league_id            INTEGER PRIMARY KEY,
    league_name          VARCHAR(200),
    season               INTEGER,
    total_matches        INTEGER DEFAULT 0,
    avg_goals_per_match  DECIMAL(4,2) DEFAULT 0,
    avg_home_goals       DECIMAL(4,2) DEFAULT 0,
    avg_away_goals       DECIMAL(4,2) DEFAULT 0,
    pct_over_05          DECIMAL(5,2) DEFAULT 0,
    pct_over_15          DECIMAL(5,2) DEFAULT 0,
    pct_over_25          DECIMAL(5,2) DEFAULT 0,
    pct_over_35          DECIMAL(5,2) DEFAULT 0,
    pct_gg               DECIMAL(5,2) DEFAULT 0,
    pct_btts             DECIMAL(5,2) DEFAULT 0,
    avg_yellow_cards     DECIMAL(4,2) DEFAULT 0,
    avg_red_cards        DECIMAL(4,2) DEFAULT 0,
    avg_corners          DECIMAL(4,2) DEFAULT 0,
    league_type          VARCHAR(20) DEFAULT 'balanced',
    updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- referee coloană în fixtures_history (adăugată idempotent)
ALTER TABLE fixtures_history ADD COLUMN IF NOT EXISTS referee TEXT;

-- NGP win-rate tracking columns on predictions
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS score_at_alert TEXT;
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS outcome_ngp    TEXT DEFAULT NULL;

-- ── 37. prediction_log ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prediction_log (
  id                  SERIAL PRIMARY KEY,
  fixture_id          INT,
  league_id           INT,
  league_name         TEXT,
  home_team           TEXT,
  away_team           TEXT,
  match_date          TIMESTAMP,
  minute              INT,
  score_at_prediction TEXT,
  venue_surface       TEXT,
  referee_name        TEXT,
  module              TEXT,
  predicted_value     NUMERIC(5,2),
  threshold_used      NUMERIC(5,2),
  lambda_home         NUMERIC(5,3),
  lambda_away         NUMERIC(5,3),
  ngp_value           NUMERIC(5,2),
  layer1_score        NUMERIC(5,2),
  layer2_score        NUMERIC(5,2),
  layer3_score        NUMERIC(5,2),
  layer4_score        NUMERIC(5,2),
  layer5_score        NUMERIC(5,2),
  layer6_score        NUMERIC(5,2),
  layer7_score        NUMERIC(5,2),
  injuries_home       INT DEFAULT 0,
  injuries_away       INT DEFAULT 0,
  outcome             TEXT DEFAULT 'PENDING',
  actual_value        NUMERIC(5,2),
  created_at          TIMESTAMP DEFAULT NOW(),
  resolved_at         TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_predlog_module   ON prediction_log(module);
CREATE INDEX IF NOT EXISTS idx_predlog_league   ON prediction_log(league_id);
CREATE INDEX IF NOT EXISTS idx_predlog_outcome  ON prediction_log(outcome);
CREATE INDEX IF NOT EXISTS idx_predlog_created  ON prediction_log(created_at);
CREATE INDEX IF NOT EXISTS idx_predlog_fixture  ON prediction_log(fixture_id);

-- ── 38. model_weights ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS model_weights (
  id                SERIAL PRIMARY KEY,
  module            TEXT NOT NULL,
  context_key       TEXT NOT NULL,
  weight_name       TEXT NOT NULL,
  weight_value      NUMERIC(8,4) NOT NULL,
  default_value     NUMERIC(8,4) NOT NULL,
  sample_size       INT DEFAULT 0,
  win_rate          NUMERIC(5,2),
  confidence_level  TEXT DEFAULT 'LOW',
  last_updated      TIMESTAMP DEFAULT NOW(),
  UNIQUE(module, context_key, weight_name)
);

-- Default weights (insert once, ignore conflicts)
INSERT INTO model_weights (module, context_key, weight_name, weight_value, default_value)
VALUES
  ('NGP',        'global', 'threshold',              70,    70),
  ('NGP',        'global', 'minute_bonus_75plus',    1.1,   1.1),
  ('NGP',        'global', 'score_00_bonus',         1.15,  1.15),
  ('OVER15',     'global', 'threshold',              65,    65),
  ('OVER15',     'global', 'lambda_multiplier',      1.0,   1.0),
  ('OVER25',     'global', 'threshold',              55,    55),
  ('GG',         'global', 'threshold',              60,    60),
  ('GG',         'global', 'home_weight',            0.35,  0.35),
  ('GG',         'global', 'away_weight',            0.35,  0.35),
  ('GG',         'global', 'h2h_weight',             0.20,  0.20),
  ('GG',         'global', 'live_weight',            0.10,  0.10),
  ('CONFIDENCE', 'global', 'layer1_weight',          0.22,  0.22),
  ('CONFIDENCE', 'global', 'layer2_weight',          0.20,  0.20),
  ('CONFIDENCE', 'global', 'layer3_weight',          0.10,  0.10),
  ('CONFIDENCE', 'global', 'layer4_weight',          0.15,  0.15),
  ('CONFIDENCE', 'global', 'layer5_weight',          0.08,  0.08),
  ('CONFIDENCE', 'global', 'layer6_weight',          0.05,  0.05),
  ('CONFIDENCE', 'global', 'layer7_weight',          0.20,  0.20),
  ('CARDS',      'global', 'threshold',              65,    65),
  ('CARDS',      'global', 'referee_multiplier',     1.0,   1.0),
  ('CORNERS',    'global', 'threshold',              65,    65),
  ('CORNERS',    'global', 'surface_artificial_bonus', 1.08, 1.08),
  ('GENERATOR',  'global', 'threshold',              60,    60)
ON CONFLICT (module, context_key, weight_name) DO NOTHING;

-- ── 39. match_snapshots ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS match_snapshots (
  fixture_id    INTEGER PRIMARY KEY,
  league_id     INTEGER,
  home_team     TEXT,
  away_team     TEXT,
  status_short  TEXT,
  minute        INTEGER,
  home_goals    INTEGER DEFAULT 0,
  away_goals    INTEGER DEFAULT 0,
  ng            INTEGER,
  over15        INTEGER,
  outcome       TEXT DEFAULT 'LIVE',
  composite_score NUMERIC(5,2),
  final_home    INTEGER,
  final_away    INTEGER,
  resolved_at   TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

-- ── 40. league_patterns ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS league_patterns (
  league_id   INTEGER PRIMARY KEY,
  sample_size INTEGER DEFAULT 0,
  avg_ng      NUMERIC(5,2),
  avg_over15  NUMERIC(5,2),
  avg_goals   NUMERIC(4,2),
  avg_cards   NUMERIC(4,2),
  avg_corners NUMERIC(4,2),
  over15_pct  NUMERIC(5,2),
  gg_pct      NUMERIC(5,2),
  updated_at  TIMESTAMP DEFAULT NOW()
);

-- ================================================================
--  INDECȘI PERFORMANȚĂ — fixtures / fixtures_history (vezi add-indexes.sql)
-- ================================================================
CREATE INDEX IF NOT EXISTS idx_fixtures_match_date    ON fixtures(match_date);
CREATE INDEX IF NOT EXISTS idx_fixtures_league_status ON fixtures(league_id, status_short);
CREATE INDEX IF NOT EXISTS idx_fixtures_home_team     ON fixtures(home_team_id);
CREATE INDEX IF NOT EXISTS idx_fixtures_away_team     ON fixtures(away_team_id);
CREATE INDEX IF NOT EXISTS idx_fixtures_date_func     ON fixtures((match_date::date));
CREATE INDEX IF NOT EXISTS idx_fh_match_date          ON fixtures_history(match_date);
CREATE INDEX IF NOT EXISTS idx_fh_league_status       ON fixtures_history(league_id, status_short);
CREATE INDEX IF NOT EXISTS idx_fh_home_team           ON fixtures_history(home_team_id);
CREATE INDEX IF NOT EXISTS idx_fh_away_team           ON fixtures_history(away_team_id);

-- ================================================================
--  VERIFICARE
-- ================================================================
SELECT 'Tables created: ' || COUNT(*) FROM information_schema.tables
WHERE table_schema = 'public' AND table_catalog = 'elefant';

SELECT 'Leagues inserted: ' || COUNT(*) FROM leagues;
