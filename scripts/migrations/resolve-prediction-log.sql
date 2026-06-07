-- ================================================================
--  resolve-prediction-log.sql
--  Rezolvă outcome-urile PENDING/NULL din prediction_log folosind
--  rezultatele finale din fixtures_history.
--
--  ⚠ MANUAL (NU e auto-aplicat de server.js). Rulează o singură dată:
--     psql -U alohascan -d elefant -h 127.0.0.1 -f scripts/migrations/resolve-prediction-log.sql
--
--  CONVENȚIE OUTCOME: 'WIN' / 'LOSS' / 'PENDING' — IDENTICĂ cu restul codului
--  (learning-analysis.js, model-accuracy.js, scanner.js, admin.js). NU folosi
--  'CORRECT'/'WRONG' — acele valori NU sunt recunoscute de win-rate (care
--  numără outcome='WIN' / outcome IN ('WIN','LOSS')) → ar fi ignorate de
--  motorul de învățare.
--
--  Toate UPDATE-urile ating DOAR rândurile NULL/PENDING (idempotent, sigur de
--  re-rulat) și DOAR meciurile cu rezultat final în fixtures_history.
-- ================================================================

-- ── PASUL 1 — Situația actuală (READ-ONLY) ──────────────────────
SELECT module, outcome, COUNT(*)
FROM prediction_log
GROUP BY module, outcome
ORDER BY module, outcome;

-- ── PASUL 2 — Rezolvă OVER15 (over 1.5 = total goluri >= 2) ──────
UPDATE prediction_log pl
SET
  outcome = CASE
    WHEN fh.home_goals + fh.away_goals >= 2 THEN 'WIN'
    ELSE 'LOSS'
  END,
  actual_value = (fh.home_goals + fh.away_goals)::numeric,
  resolved_at = NOW()
FROM fixtures_history fh
WHERE fh.fixture_id = pl.fixture_id
  AND pl.module = 'OVER15'
  AND (pl.outcome IS NULL OR pl.outcome = 'PENDING')
  AND fh.home_goals IS NOT NULL;

-- ── PASUL 3 — Rezolvă GG (ambele echipe marchează) ──────────────
UPDATE prediction_log pl
SET
  outcome = CASE
    WHEN fh.home_goals > 0 AND fh.away_goals > 0 THEN 'WIN'
    ELSE 'LOSS'
  END,
  actual_value = CASE
    WHEN fh.home_goals > 0 AND fh.away_goals > 0 THEN 1
    ELSE 0
  END,
  resolved_at = NOW()
FROM fixtures_history fh
WHERE fh.fixture_id = pl.fixture_id
  AND pl.module = 'GG'
  AND (pl.outcome IS NULL OR pl.outcome = 'PENDING')
  AND fh.home_goals IS NOT NULL;

-- ── PASUL 4 — Rezolvă NGP (a mai căzut un gol DUPĂ minutul predicției) ──
--  Compară scorul final cu scorul din ultimul snapshot live <= minutul
--  predicției. Dacă au mai căzut goluri după → WIN.
UPDATE prediction_log pl
SET
  outcome = CASE
    WHEN fh.home_goals + fh.away_goals > COALESCE(
      (SELECT home_goals + away_goals FROM live_stats ls
       WHERE ls.fixture_id = pl.fixture_id
         AND ls.elapsed <= pl.minute
       ORDER BY ls.elapsed DESC LIMIT 1), 0)
    THEN 'WIN'
    ELSE 'LOSS'
  END,
  actual_value = (fh.home_goals + fh.away_goals)::numeric,
  resolved_at = NOW()
FROM fixtures_history fh
WHERE fh.fixture_id = pl.fixture_id
  AND pl.module = 'NGP'
  AND (pl.outcome IS NULL OR pl.outcome = 'PENDING')
  AND fh.home_goals IS NOT NULL;

-- ── PASUL 5 — Rezolvă CONFIDENCE (țintă over 1.5 = total goluri >= 2) ──
UPDATE prediction_log pl
SET
  outcome = CASE
    WHEN fh.home_goals + fh.away_goals >= 2 THEN 'WIN'
    ELSE 'LOSS'
  END,
  actual_value = (fh.home_goals + fh.away_goals)::numeric,
  resolved_at = NOW()
FROM fixtures_history fh
WHERE fh.fixture_id = pl.fixture_id
  AND pl.module = 'CONFIDENCE'
  AND (pl.outcome IS NULL OR pl.outcome = 'PENDING')
  AND fh.home_goals IS NOT NULL;

-- ── PASUL 6 — Verificare finală ─────────────────────────────────
SELECT module, outcome, COUNT(*) AS total
FROM prediction_log
GROUP BY module, outcome
ORDER BY module, outcome;
