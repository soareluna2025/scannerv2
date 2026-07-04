-- P2 — create-learning-exclusions.sql
-- Tabelă de excludere a ligilor din self-learning (prediction_log agregări + P4c threshold).
-- Rulare (Termius, o linie):
--   cd /root/scannerv2 && set -a && . ./.env && set +a && psql "$POSTGRES_URL" -f scripts/create-learning-exclusions.sql

CREATE TABLE IF NOT EXISTS learning_exclusions (
  league_id  INT PRIMARY KEY,
  reason     TEXT,
  added_at   TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO learning_exclusions (league_id, reason)
VALUES (290, 'NGP 100% LOSS n=1346, 0 match in fixtures_history, de investigat')
ON CONFLICT (league_id) DO NOTHING;

SELECT * FROM learning_exclusions ORDER BY league_id;
