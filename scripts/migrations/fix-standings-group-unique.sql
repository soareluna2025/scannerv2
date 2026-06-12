-- [WC FIX] standings: aceeași echipă poate apărea în grupa ei ȘI în clasamentul
-- „Ranking of third-placed teams". Cheia veche UNIQUE(league_id,season,team_id)
-- suprascria rândul de grupă (locul 3) cu rândul din clasamentul locurilor 3 →
-- fiecare grupă rămânea cu rankurile 1,2,4. Cheia nouă include group_name
-- (NULL → '' ca ligile fără grupe să rămână unice). Idempotent.
-- Aplicat automat la boot (server.js ensureColumns).

-- 1) Deduplică eventualele rânduri identice pe NOUA cheie (păstrează id-ul mare = cel mai recent).
DELETE FROM standings a USING standings b
 WHERE a.id < b.id
   AND a.league_id = b.league_id
   AND a.season    = b.season
   AND a.team_id   = b.team_id
   AND COALESCE(a.group_name, '') = COALESCE(b.group_name, '');

-- 2) Renunță la constraintul UNIQUE vechi pe (league_id,season,team_id) — căutat DINAMIC
--    după definiție (robust la orice nume auto-generat de Postgres).
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'standings'::regclass AND contype = 'u'
     AND pg_get_constraintdef(oid) = 'UNIQUE (league_id, season, team_id)';
  IF c IS NOT NULL THEN
    EXECUTE 'ALTER TABLE standings DROP CONSTRAINT ' || quote_ident(c);
  END IF;
END $$;
-- fallback pe numele implicit (no-op dacă DO l-a șters deja sau nu există)
ALTER TABLE standings DROP CONSTRAINT IF EXISTS standings_league_id_season_team_id_key;

-- 3) Cheie nouă: include grupa. NULL tratat ca '' → o echipă într-o ligă/sezon fără grupe
--    rămâne unică; o echipă poate exista în „Group X" ȘI în „Ranking of third-placed teams".
CREATE UNIQUE INDEX IF NOT EXISTS idx_standings_uniq_group
  ON standings (league_id, season, team_id, COALESCE(group_name, ''));
