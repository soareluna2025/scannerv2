-- Migration ONE-TIME: populează feature-urile ML (ELO + poziție clasament) în
-- predictions, din elo_history + standings. Idempotent (UPDATE ... WHERE col IS NULL).
-- Coloanele sunt create de add-prediction-features.sql (auto la startup).
--
-- Rulare manuală pe VPS:
--   psql -U alohascan -d elefant -f scripts/migrations/backfill-ml-features.sql
--
-- NOTĂ: predictions NU are home_team_id/away_team_id/season → poziția se ia
-- punte prin fixtures_history (care le are), pe fixture_id.

-- ── PASUL 3: ELO din elo_history (point-in-time, pe fixture_id) ──
UPDATE predictions p
SET home_elo          = eh.home_elo,
    away_elo          = eh.away_elo,
    elo_diff_ml       = eh.elo_diff,
    home_win_prob_elo = eh.home_win_prob
FROM elo_history eh
WHERE eh.fixture_id = p.fixture_id
  AND p.home_elo IS NULL;

-- ── PASUL 4: poziție clasament din standings (punte via fixtures_history) ──
UPDATE predictions p
SET home_position = s_h.rank,
    away_position = s_a.rank
FROM fixtures_history fh
JOIN standings s_h ON s_h.team_id   = fh.home_team_id
                  AND s_h.league_id = fh.league_id
                  AND s_h.season    = fh.season
JOIN standings s_a ON s_a.team_id   = fh.away_team_id
                  AND s_a.league_id = fh.league_id
                  AND s_a.season    = fh.season
WHERE fh.fixture_id = p.fixture_id
  AND p.home_position IS NULL;

-- ── PASUL 5: normalizare poziție (0 = primul, 1 = ultimul) ──
UPDATE predictions
SET home_position_norm = (home_position - 1.0) / NULLIF(
      (SELECT MAX(rank) FROM standings WHERE league_id = predictions.league_id) - 1, 0),
    away_position_norm = (away_position - 1.0) / NULLIF(
      (SELECT MAX(rank) FROM standings WHERE league_id = predictions.league_id) - 1, 0)
WHERE home_position IS NOT NULL
  AND away_position IS NOT NULL
  AND home_position_norm IS NULL;

-- ── PASUL 6: raport ──
SELECT
  COUNT(*)                                                                       AS total_predictii,
  COUNT(home_elo)                                                                AS cu_elo,
  COUNT(home_position)                                                           AS cu_pozitie,
  COUNT(CASE WHEN home_elo IS NOT NULL AND home_position IS NOT NULL THEN 1 END) AS complete_ml
FROM predictions
WHERE result_winner IS NOT NULL;
