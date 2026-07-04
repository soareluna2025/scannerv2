-- P4b — create-adaptive-shadow.sql
-- Tabelă de shadow-logging pt divergențele static-vs-adaptiv ale porții de selecție.
-- (api/adaptive-threshold.js o creează și lazy, dar o ținem și ca migrare canonică.)
-- Rulare (Termius, o linie):
--   cd /root/scannerv2 && set -a && . ./.env && set +a && psql "$POSTGRES_URL" -f scripts/create-adaptive-shadow.sql

CREATE TABLE IF NOT EXISTS adaptive_shadow_log (
  id                SERIAL PRIMARY KEY,
  fixture_id        INT,
  module            TEXT,
  league_id         INT,
  static_thr        NUMERIC,
  adaptive_thr      NUMERIC,
  predicted_value   NUMERIC,
  static_decision   BOOLEAN,
  adaptive_decision BOOLEAN,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_adaptive_shadow_fx_mod
  ON adaptive_shadow_log(fixture_id, module);

SELECT COUNT(*) AS shadow_rows FROM adaptive_shadow_log;
