-- Migration: adaugă Cupa Egiptului (league_id=714) în tabela `leagues`.
-- API-Football: name="Cup", country="Egypt", type="Cup".
-- Convenție: cupă națională = tier 2 (ca toate cupele naționale din seed).
-- timezone + active_hours copiate de la Egypt Premier League (233): Africa/Cairo, 18-23.
-- logo = media.api-sports.io/football/leagues/714.png; flag = Egipt (eg.svg, ca la 233).
-- Idempotent: ON CONFLICT (league_id) DO UPDATE. Rulează manual pe VPS:
--   psql -U alohascan -d elefant -f scripts/migrations/add-egypt-cup-714.sql
INSERT INTO leagues
  (league_id, name, country, tier, timezone, active_hours_start, active_hours_end, active, logo, flag)
VALUES
  (714, 'Egypt Cup', 'Egypt', 2, 'Africa/Cairo', 18, 23, TRUE,
   'https://media.api-sports.io/football/leagues/714.png',
   'https://media.api-sports.io/flags/eg.svg')
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
