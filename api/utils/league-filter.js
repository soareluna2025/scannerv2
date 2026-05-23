// api/utils/league-filter.js
// Filtru centralizat: feminin / tineret / ligi inferioare
// Folosit în football.js, today.js, generator.js, scanner.js

export const WOMEN_TERMS = [
  'women', 'female', 'ladies', 'lady', 'girl',
  'féminin', 'feminin', 'femenino', 'femenina',
  'frauen', 'damen', 'dame', 'dames',
  'vrouwen', 'vrouw',
  'naiset', 'naisten',
  'kvinnor', 'kvinna',
  'mulheres', 'feminino',
  'mujer', 'mujeres',
  'ženy', 'ženský',
  'kobiety', 'kobiet',
  'donne', 'femminile',
  'nők', 'női',
  'kadın', 'bayanlar', 'kadin',
  'feminil', 'femení',
];

export const YOUTH_TERMS = [
  'under', 'u17', 'u18', 'u19', 'u20', 'u21', 'u22', 'u23',
  'youth', 'junior', 'juniors', 'reserve', 'reserves',
  'juvenil', 'juveniles', 'jugend', 'jeunes', 'jeunesse',
  'jovenes', 'jovens', 'academy', 'academie',
  'b team', 'b-team', 'second team', 'development',
  'primavera', 'espoirs', 'sub-17', 'sub-20', 'sub-23',
];

export const LOWER_DIV_TERMS = [
  'oberliga', 'landesliga', 'kreisliga', 'bezirksliga',
  'regionalliga', 'verbandsliga', 'westfalenliga',
  'isthmian', 'southern league', 'northern league',
  'national league north', 'national league south',
  'amateur', 'sunday league', 'district', 'county',
  'serie d', 'serie c', 'liga 3', 'liga 4', 'liga 5',
  'division 3', 'division 4', 'division 5',
  'tercera', 'cuarta', 'quinta',
  'ligue 3', 'ligue 4', 'national 2', 'national 3',
  '3. liga', '4. liga',
  'futsal', 'beach soccer', 'beach football',
  'indoor', 'arena football', 'virtual',
  // Meciuri amicale
  'friendly', 'friendlies', 'friendl', 'amical', 'test match',
  // Ligi americane sub USL Championship (nivel 2 SUA)
  'usl league one', 'usl league two', 'usl super league',
  'nisa', 'national independent soccer',
  'mls next pro', 'usoc',
];

/**
 * Verifică dacă o ligă e permisă: ID în whitelist + fără termeni interzisi în nume.
 */
export function isAllowedLeague(leagueName, leagueId, allowedIds) {
  if (!leagueName) return false;
  if (!allowedIds.has(Number(leagueId))) return false;

  const name = leagueName.toLowerCase().trim();

  for (const term of WOMEN_TERMS)    { if (name.includes(term)) return false; }
  for (const term of YOUTH_TERMS)    { if (name.includes(term)) return false; }
  for (const term of LOWER_DIV_TERMS){ if (name.includes(term)) return false; }

  return true;
}

/**
 * Verifică dacă un meci e permis: liga OK + echipele nu sunt feminine.
 * match trebuie să aibă: match.league.{name,id}, match.teams.home.name, match.teams.away.name
 */
export function isAllowedMatch(match, allowedIds) {
  const leagueName = match.league?.name  || '';
  const leagueId   = match.league?.id;
  const homeTeam   = (match.teams?.home?.name || '').trim();
  const awayTeam   = (match.teams?.away?.name || '').trim();

  if (!isAllowedLeague(leagueName, leagueId, allowedIds)) return false;

  // Echipe care se termină cu " W" — desemnare feminin în API-Football
  if (/\sW$/i.test(homeTeam) || /\sW$/i.test(awayTeam)) return false;

  // Termeni feminini în numele echipelor
  const hl = homeTeam.toLowerCase();
  const al = awayTeam.toLowerCase();
  for (const term of WOMEN_TERMS) {
    if (hl.includes(term) || al.includes(term)) return false;
  }

  return true;
}
