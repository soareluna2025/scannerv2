-- Faza 2 — add-pit-columns.sql (idempotent)
-- Coloane point-in-time în feature store ml_features pentru retrain-ul din Faza 3.
--   pit_score7      — PutereEchipe recalculat POINT-IN-TIME (player_stats < match_date).
--   pit_score6      — Convergență pe [s1,s2,s3,pit_score7] (s1-3 din predictions).
--   pit_confidence  — calcConfidencePreMatch cu pit_score7 (0.30/0.25/0.15/0.25/0.05).
--   pit_players_n   — LEAST(home_window_n, away_window_n) = câte rânduri player-meci a avut
--                     echipa cu fereastra mai mică (≤110) la momentul meciului. Marker de
--                     PROCESARE (setat mereu, chiar și când pit_score7=NULL) + filtru calitate.
-- Rulare (Termius, o linie):
--   cd /root/scannerv2 && set -a && . ./.env && set +a && psql "$POSTGRES_URL" -f scripts/add-pit-columns.sql

ALTER TABLE ml_features ADD COLUMN IF NOT EXISTS pit_score7     NUMERIC;
ALTER TABLE ml_features ADD COLUMN IF NOT EXISTS pit_score6     NUMERIC;
ALTER TABLE ml_features ADD COLUMN IF NOT EXISTS pit_confidence NUMERIC;
ALTER TABLE ml_features ADD COLUMN IF NOT EXISTS pit_players_n  SMALLINT;

\d ml_features
