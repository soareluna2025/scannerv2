// api/utils/standings-normalize.js
// Normalizare group_name pentru standings. La startul CM 2026, API-Football a redenumit
// grupele ligii 1: "Group A" → "Group Stage - Group A", iar clasamentul locurilor 3
// "Ranking of third-placed teams" → "Group Stage" (exact, fără sufix). Reparăm la SCRIERE
// dintr-un singur loc, ca viitoarele redenumiri API să se trateze aici, nu în fiecare colector.
//
// Reguli (DOAR pentru league_id=1 — nu atinge ligile domestice care pot avea grupe proprii):
//   "Group Stage - Group X" → "Group X"   (liniuță -, –, — cu spații variabile)
//   "Group Stage" (exact)   → "Ranking of third-placed teams"
//   orice alt nume          → neschimbat

export function normalizeStandingsGroup(group, leagueId) {
  if (group == null) return null;
  if (Number(leagueId) !== 1) return group;   // canonicalizare doar pentru Cupa Mondială
  const s = String(group).trim();
  const m = s.match(/^Group Stage\s*[-–—]\s*(Group\s+.+)$/i);
  if (m) return m[1].trim();
  if (/^Group Stage$/i.test(s)) return 'Ranking of third-placed teams';
  return group;
}
