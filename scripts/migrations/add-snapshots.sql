-- Migration: adaugă tabelele match_snapshots și league_patterns
-- Aplică cu: psql "$POSTGRES_URL" -f scripts/migrations/add-snapshots.sql
-- Idempotent — folosește CREATE TABLE IF NOT EXISTS

-- ── match_snapshots ──────────────────────────────────────────────────────────
-- Scris de: api/cron/scan.js la fiecare minut (un rând per fixture activ)
-- outcome: 'LIVE' → 'WIN'/'LOSS' după finalizare meci
CREATE TABLE IF NOT EXISTS match_snapshots (
    id           SERIAL PRIMARY KEY,
    fixture_id   INTEGER NOT NULL,
    league_id    INTEGER,
    home_team    TEXT,
    away_team    TEXT,
    status_short TEXT,
    minute       INTEGER,
    home_goals   INTEGER DEFAULT 0,
    away_goals   INTEGER DEFAULT 0,
    ng           INTEGER,
    over15       INTEGER,
    outcome      TEXT DEFAULT 'LIVE',
    final_home   INTEGER,
    final_away   INTEGER,
    resolved_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT match_snapshots_fixture_uq UNIQUE (fixture_id)
);

CREATE INDEX IF NOT EXISTS idx_match_snapshots_league  ON match_snapshots(league_id);
CREATE INDEX IF NOT EXISTS idx_match_snapshots_outcome ON match_snapshots(outcome);

-- ── league_patterns ──────────────────────────────────────────────────────────
-- Scris de: api/cron/scan.js la fiecare 10 rulări (agregat din match_snapshots)
CREATE TABLE IF NOT EXISTS league_patterns (
    league_id    INTEGER PRIMARY KEY,
    sample_size  INTEGER,
    avg_ng       INTEGER,
    avg_over15   INTEGER,
    updated_at   TIMESTAMPTZ DEFAULT NOW()
);
