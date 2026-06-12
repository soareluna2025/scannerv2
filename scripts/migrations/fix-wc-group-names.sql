-- [WC ONE-TIME] CM 2026: API-Football a redenumit standings ligii 1:
--   "Group A" → "Group Stage - Group A"   (toate grupele)
--   "Ranking of third-placed teams" → "Group Stage"  (exact, fără sufix, 12 echipe)
-- Canonicalizăm rândurile EXISTENTE (league_id=1, season=2026) la forma folosită de
-- frontend. Colectorii normalizează deja la scriere (api/utils/standings-normalize.js),
-- deci asta repară doar datele deja salvate cu numele noi.
-- Rândurile stale cu numele vechi au fost șterse manual → fără coliziuni pe unique index
-- (league_id, season, team_id, COALESCE(group_name,'')).

-- 1) "Group Stage - Group X" → "Group X" (liniuță -, –, — cu spații variabile)
UPDATE standings
   SET group_name = btrim(regexp_replace(group_name, '^Group Stage\s*[-–—]\s*(Group\s+.+)$', '\1', 'i'))
 WHERE league_id = 1 AND season = 2026
   AND group_name ~* '^Group Stage\s*[-–—]\s*Group\s+.+$';

-- 2) "Group Stage" exact → clasamentul locurilor 3
UPDATE standings
   SET group_name = 'Ranking of third-placed teams'
 WHERE league_id = 1 AND season = 2026
   AND group_name ~* '^Group Stage$';
