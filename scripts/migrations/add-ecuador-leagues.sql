-- Migration: integrare ligi Ecuador în tabela `leagues`.
-- 242 = LigaPro Primera A (prima divizie, tier 1) — lipsea complet.
-- 917 = Copa Ecuador (ID CORECT, tier 3) — DB avea 735 (greșit).
-- 735 = ID vechi greșit → DEZACTIVAT (active=false), NU șters.
-- Idempotent (ON CONFLICT DO UPDATE). Rulează manual pe VPS:
--   psql -U alohascan -d elefant -f scripts/migrations/add-ecuador-leagues.sql

INSERT INTO leagues
  (league_id, name, country, tier, timezone, active_hours_start, active_hours_end, active, logo, flag)
VALUES
  (242, 'LigaPro Primera A', 'Ecuador', 1, 'America/Guayaquil', 19, 2, TRUE,
   'https://media.api-sports.io/football/leagues/242.png',
   'https://media.api-sports.io/flags/ec.svg'),
  (917, 'Copa Ecuador',      'Ecuador', 3, 'America/Guayaquil', 19, 2, TRUE,
   'https://media.api-sports.io/football/leagues/917.png',
   'https://media.api-sports.io/flags/ec.svg')
ON CONFLICT (league_id) DO UPDATE SET
  name               = EXCLUDED.name,
  country            = EXCLUDED.country,
  tier               = EXCLUDED.tier,
  timezone           = EXCLUDED.timezone,
  active_hours_start = EXCLUDED.active_hours_start,
  active_hours_end   = EXCLUDED.active_hours_end,
  active             = TRUE,
  logo               = EXCLUDED.logo,
  flag               = EXCLUDED.flag,
  updated_at         = NOW();

-- ID vechi greșit — dezactivat, păstrat în DB (nu șters).
UPDATE leagues SET active = FALSE, updated_at = NOW() WHERE league_id = 735;
