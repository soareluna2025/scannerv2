-- Migration: activează în tabelul `leagues` pachetul SA + Algeria (48 ID-uri țintă).
-- Idempotent: pe ligile deja active = no-op. NU inventează nume/tier (doar active=true).
-- Rulează manual pe VPS:
--   psql -U alohascan -d elefant -f scripts/migrations/add-leagues-sa-batch.sql
UPDATE leagues SET active = true WHERE league_id IN (71,72,75,76,73,612,239,240,241,268,270,269,930,250,252,251,501,344,710,964,242,243,917,265,266,711,267,281,282,502,128,129,130,131,132,134,483,517,810,906,1032,1067,1178,186,187,514,516,832);
