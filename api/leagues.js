// ─── HYBRID LEAGUES ARCHITECTURE ───────────────────────────────────────────
// Tier 1: live la 10s  (3 endpoints: statistics + events + odds/live)
// Tier 2: live la 30s  (2 endpoints: statistics + events)
// Tier 3: live la 2min (1 endpoint:  events)
//
// Ferestre orare Germania (UTC+2):
//   WINDOW_1: 06-12  → Asia
//   WINDOW_2: 12-16  → Asia tarzie + Europa inceput
//   WINDOW_3: 16-23  → Europa PEAK + America Sud
//   WINDOW_4: 23-02  → America Nord/Sud
//   WINDOW_5: 02-06  → Minim (backfill + referinta)
// ───────────────────────────────────────────────────────────────────────────

export const LEAGUES = [

  // ═══════════════════════════════════════════════════════════════
  // TIER 1 — live 10s, 3 endpoints
  // ═══════════════════════════════════════════════════════════════

  // ── Europa Tier 1 ──────────────────────────────────────────────
  { id: 39,  tier: 1, country: 'England',       name: 'Premier League',         timezone: 'UTC+1', active_hours: '14:00-22:00' },
  { id: 40,  tier: 1, country: 'England',       name: 'Championship',           timezone: 'UTC+1', active_hours: '14:00-22:00' },
  { id: 45,  tier: 1, country: 'England',       name: 'FA Cup',                 timezone: 'UTC+1', active_hours: '14:00-22:00' },
  { id: 140, tier: 1, country: 'Spain',         name: 'La Liga',                timezone: 'UTC+2', active_hours: '14:00-23:00' },
  { id: 141, tier: 1, country: 'Spain',         name: 'Segunda Division',       timezone: 'UTC+2', active_hours: '14:00-23:00' },
  { id: 143, tier: 1, country: 'Spain',         name: 'Copa del Rey',           timezone: 'UTC+2', active_hours: '14:00-23:00' },
  { id: 78,  tier: 1, country: 'Germany',       name: 'Bundesliga',             timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 79,  tier: 1, country: 'Germany',       name: '2. Bundesliga',          timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 81,  tier: 1, country: 'Germany',       name: 'DFB Pokal',              timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 135, tier: 1, country: 'Italy',         name: 'Serie A',                timezone: 'UTC+2', active_hours: '15:00-23:00' },
  { id: 136, tier: 1, country: 'Italy',         name: 'Serie B',                timezone: 'UTC+2', active_hours: '15:00-23:00' },
  { id: 137, tier: 1, country: 'Italy',         name: 'Coppa Italia',           timezone: 'UTC+2', active_hours: '15:00-23:00' },
  { id: 61,  tier: 1, country: 'France',        name: 'Ligue 1',                timezone: 'UTC+2', active_hours: '15:00-23:00' },
  { id: 62,  tier: 1, country: 'France',        name: 'Ligue 2',                timezone: 'UTC+2', active_hours: '15:00-23:00' },
  { id: 66,  tier: 1, country: 'France',        name: 'Coupe de France',        timezone: 'UTC+2', active_hours: '15:00-23:00' },

  // ── America Sud Tier 1 ─────────────────────────────────────────
  { id: 71,  tier: 1, country: 'Brazil',        name: 'Serie A',                timezone: 'UTC-3', active_hours: '18:00-02:00' },
  { id: 72,  tier: 1, country: 'Brazil',        name: 'Serie B',                timezone: 'UTC-3', active_hours: '18:00-02:00' },
  { id: 73,  tier: 1, country: 'Brazil',        name: 'Copa do Brasil',         timezone: 'UTC-3', active_hours: '18:00-02:00' },
  { id: 128, tier: 1, country: 'Argentina',     name: 'Primera Division',       timezone: 'UTC-3', active_hours: '19:00-02:00' },
  { id: 131, tier: 1, country: 'Argentina',     name: 'Primera Nacional',       timezone: 'UTC-3', active_hours: '19:00-02:00' },
  { id: 132, tier: 1, country: 'Argentina',     name: 'Copa Argentina',         timezone: 'UTC-3', active_hours: '19:00-02:00' },

  // ── America Nord Tier 1 ────────────────────────────────────────
  { id: 262, tier: 1, country: 'Mexico',        name: 'Liga MX',                timezone: 'UTC-6', active_hours: '20:00-04:00' },
  { id: 263, tier: 1, country: 'Mexico',        name: 'Liga Expansion MX',      timezone: 'UTC-6', active_hours: '20:00-04:00' },
  { id: 264, tier: 1, country: 'Mexico',        name: 'Copa MX',                timezone: 'UTC-6', active_hours: '20:00-04:00' },
  { id: 253, tier: 1, country: 'USA',           name: 'MLS',                    timezone: 'UTC-5', active_hours: '20:00-04:00' },
  { id: 255, tier: 1, country: 'USA',           name: 'USL Championship',       timezone: 'UTC-5', active_hours: '20:00-04:00' },
  { id: 257, tier: 1, country: 'USA',           name: 'US Open Cup',            timezone: 'UTC-5', active_hours: '20:00-04:00' },

  // ── Asia Tier 1 ────────────────────────────────────────────────
  { id: 98,  tier: 1, country: 'Japan',         name: 'J1 League',              timezone: 'UTC+9', active_hours: '07:00-16:00' },
  { id: 99,  tier: 1, country: 'Japan',         name: 'J2 League',              timezone: 'UTC+9', active_hours: '07:00-16:00' },
  { id: 100, tier: 1, country: 'Japan',         name: 'Emperors Cup',           timezone: 'UTC+9', active_hours: '07:00-16:00' },
  { id: 292, tier: 1, country: 'Korea',         name: 'K League 1',             timezone: 'UTC+9', active_hours: '07:00-16:00' },
  { id: 293, tier: 1, country: 'Korea',         name: 'K League 2',             timezone: 'UTC+9', active_hours: '07:00-16:00' },
  { id: 294, tier: 1, country: 'Korea',         name: 'Korean FA Cup',          timezone: 'UTC+9', active_hours: '07:00-16:00' },

  // ── Internationale Tier 1 ──────────────────────────────────────
  { id: 2,   tier: 1, country: 'International', name: 'UEFA Champions League',  timezone: 'UTC+2', active_hours: '16:00-23:00' },
  { id: 3,   tier: 1, country: 'International', name: 'UEFA Europa League',     timezone: 'UTC+2', active_hours: '16:00-23:00' },
  { id: 13,  tier: 1, country: 'International', name: 'Copa Libertadores',      timezone: 'UTC-3', active_hours: '19:00-02:00' },
  { id: 1,   tier: 1, country: 'International', name: 'FIFA World Cup',         timezone: 'UTC+2', active_hours: '14:00-23:00' },

  // ═══════════════════════════════════════════════════════════════
  // TIER 2 — live 30s, 2 endpoints
  // ═══════════════════════════════════════════════════════════════

  // ── Europa Tier 2 ──────────────────────────────────────────────
  { id: 88,  tier: 2, country: 'Netherlands',   name: 'Eredivisie',             timezone: 'UTC+2', active_hours: '14:00-22:00' },
  { id: 89,  tier: 2, country: 'Netherlands',   name: 'Eerste Divisie',         timezone: 'UTC+2', active_hours: '14:00-22:00' },
  { id: 90,  tier: 2, country: 'Netherlands',   name: 'KNVB Cup',               timezone: 'UTC+2', active_hours: '14:00-22:00' },
  { id: 94,  tier: 2, country: 'Portugal',      name: 'Primeira Liga',          timezone: 'UTC+1', active_hours: '14:00-23:00' },
  { id: 95,  tier: 2, country: 'Portugal',      name: 'Liga Portugal 2',        timezone: 'UTC+1', active_hours: '14:00-23:00' },
  { id: 96,  tier: 2, country: 'Portugal',      name: 'Taca de Portugal',       timezone: 'UTC+1', active_hours: '14:00-23:00' },
  { id: 203, tier: 2, country: 'Turkey',        name: 'Super Lig',              timezone: 'UTC+3', active_hours: '15:00-22:00' },
  { id: 204, tier: 2, country: 'Turkey',        name: 'TFF First League',       timezone: 'UTC+3', active_hours: '15:00-22:00' },
  { id: 205, tier: 2, country: 'Turkey',        name: 'Turkish Cup',            timezone: 'UTC+3', active_hours: '15:00-22:00' },
  { id: 144, tier: 2, country: 'Belgium',       name: 'Pro League',             timezone: 'UTC+2', active_hours: '14:00-22:00' },
  { id: 145, tier: 2, country: 'Belgium',       name: 'Challenger Pro',         timezone: 'UTC+2', active_hours: '14:00-22:00' },
  { id: 146, tier: 2, country: 'Belgium',       name: 'Belgian Cup',            timezone: 'UTC+2', active_hours: '14:00-22:00' },
  { id: 179, tier: 2, country: 'Scotland',      name: 'Premiership',            timezone: 'UTC+1', active_hours: '14:00-22:00' },
  { id: 180, tier: 2, country: 'Scotland',      name: 'Championship',           timezone: 'UTC+1', active_hours: '14:00-22:00' },
  { id: 184, tier: 2, country: 'Scotland',      name: 'Scottish Cup',           timezone: 'UTC+1', active_hours: '14:00-22:00' },
  { id: 106, tier: 2, country: 'Poland',        name: 'Ekstraklasa',            timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 107, tier: 2, country: 'Poland',        name: 'I Liga',                 timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 108, tier: 2, country: 'Poland',        name: 'Polish Cup',             timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 551, tier: 2, country: 'Greece',        name: 'Super League 1',         timezone: 'UTC+3', active_hours: '15:00-22:00' },
  { id: 552, tier: 2, country: 'Greece',        name: 'Super League 2',         timezone: 'UTC+3', active_hours: '15:00-22:00' },
  { id: 556, tier: 2, country: 'Greece',        name: 'Greek Cup',              timezone: 'UTC+3', active_hours: '15:00-22:00' },
  { id: 218, tier: 2, country: 'Austria',       name: 'Bundesliga',             timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 219, tier: 2, country: 'Austria',       name: '2. Liga',                timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 221, tier: 2, country: 'Austria',       name: 'OFB Cup',                timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 207, tier: 2, country: 'Switzerland',   name: 'Super League',           timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 208, tier: 2, country: 'Switzerland',   name: 'Challenge League',       timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 209, tier: 2, country: 'Switzerland',   name: 'Swiss Cup',              timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 345, tier: 2, country: 'Czech',         name: 'Fortuna Liga',           timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 346, tier: 2, country: 'Czech',         name: 'FNL',                    timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 347, tier: 2, country: 'Czech',         name: 'MOL Cup',                timezone: 'UTC+2', active_hours: '15:00-22:00' },

  // ── America Sud Tier 2 ─────────────────────────────────────────
  { id: 239, tier: 2, country: 'Colombia',      name: 'Primera A',              timezone: 'UTC-5', active_hours: '19:00-03:00' },
  { id: 240, tier: 2, country: 'Colombia',      name: 'Primera B',              timezone: 'UTC-5', active_hours: '19:00-03:00' },
  { id: 241, tier: 2, country: 'Colombia',      name: 'Copa Colombia',          timezone: 'UTC-5', active_hours: '19:00-03:00' },
  { id: 265, tier: 2, country: 'Chile',         name: 'Primera Division',       timezone: 'UTC-4', active_hours: '19:00-03:00' },
  { id: 266, tier: 2, country: 'Chile',         name: 'Primera B',              timezone: 'UTC-4', active_hours: '19:00-03:00' },
  { id: 267, tier: 2, country: 'Chile',         name: 'Copa Chile',             timezone: 'UTC-4', active_hours: '19:00-03:00' },
  { id: 268, tier: 2, country: 'Uruguay',       name: 'Primera Division',       timezone: 'UTC-3', active_hours: '19:00-02:00' },
  { id: 269, tier: 2, country: 'Uruguay',       name: 'Segunda Division',       timezone: 'UTC-3', active_hours: '19:00-02:00' },
  { id: 270, tier: 2, country: 'Uruguay',       name: 'Copa Uruguay',           timezone: 'UTC-3', active_hours: '19:00-02:00' },
  { id: 286, tier: 2, country: 'Ecuador',       name: 'LigaPro Serie A',        timezone: 'UTC-5', active_hours: '19:00-03:00' },
  { id: 287, tier: 2, country: 'Ecuador',       name: 'LigaPro Serie B',        timezone: 'UTC-5', active_hours: '19:00-03:00' },
  { id: 735, tier: 2, country: 'Ecuador',       name: 'Copa Ecuador',           timezone: 'UTC-5', active_hours: '19:00-03:00' },

  // ── America Nord Tier 2 ────────────────────────────────────────
  { id: 321, tier: 2, country: 'Canada',        name: 'Canadian Premier',       timezone: 'UTC-5', active_hours: '20:00-04:00' },
  { id: 322, tier: 2, country: 'Canada',        name: 'Canadian Championship',  timezone: 'UTC-5', active_hours: '20:00-04:00' },
  { id: 258, tier: 2, country: 'Costa Rica',    name: 'Primera Division',       timezone: 'UTC-6', active_hours: '21:00-04:00' },
  { id: 259, tier: 2, country: 'Costa Rica',    name: 'Segunda Division',       timezone: 'UTC-6', active_hours: '21:00-04:00' },
  { id: 260, tier: 2, country: 'Costa Rica',    name: 'Copa Costa Rica',        timezone: 'UTC-6', active_hours: '21:00-04:00' },

  // ── Asia Tier 2 ────────────────────────────────────────────────
  { id: 307, tier: 2, country: 'Saudi',         name: 'Saudi Pro League',       timezone: 'UTC+3', active_hours: '15:00-22:00' },
  { id: 308, tier: 2, country: 'Saudi',         name: 'First Division',         timezone: 'UTC+3', active_hours: '15:00-22:00' },
  { id: 313, tier: 2, country: 'Saudi',         name: 'King Cup',               timezone: 'UTC+3', active_hours: '15:00-22:00' },
  { id: 169, tier: 2, country: 'China',         name: 'Super League',           timezone: 'UTC+8', active_hours: '08:00-16:00' },
  { id: 170, tier: 2, country: 'China',         name: 'League One',             timezone: 'UTC+8', active_hours: '08:00-16:00' },
  { id: 171, tier: 2, country: 'China',         name: 'FA Cup',                 timezone: 'UTC+8', active_hours: '08:00-16:00' },
  { id: 290, tier: 2, country: 'Iran',          name: 'Persian Gulf Pro',       timezone: 'UTC+3.5', active_hours: '15:00-22:00' },
  { id: 291, tier: 2, country: 'Iran',          name: 'Azadegan League',        timezone: 'UTC+3.5', active_hours: '15:00-22:00' },
  { id: 295, tier: 2, country: 'Iran',          name: 'Hazfi Cup',              timezone: 'UTC+3.5', active_hours: '15:00-22:00' },
  { id: 19,  tier: 2, country: 'Qatar',         name: 'Qatar Stars League',     timezone: 'UTC+3', active_hours: '15:00-22:00' },
  { id: 21,  tier: 2, country: 'Qatar',         name: 'QSL Cup',                timezone: 'UTC+3', active_hours: '15:00-22:00' },
  { id: 22,  tier: 2, country: 'Qatar',         name: 'Emir Cup',               timezone: 'UTC+3', active_hours: '15:00-22:00' },

  // ── Africa Tier 2 ──────────────────────────────────────────────
  { id: 233, tier: 2, country: 'Egypt',         name: 'Premier League',         timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 234, tier: 2, country: 'Egypt',         name: 'Second Division',        timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 238, tier: 2, country: 'Egypt',         name: 'Egyptian Cup',           timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 200, tier: 2, country: 'Morocco',       name: 'Botola Pro',             timezone: 'UTC+1', active_hours: '15:00-22:00' },
  { id: 201, tier: 2, country: 'Morocco',       name: 'Botola 2',               timezone: 'UTC+1', active_hours: '15:00-22:00' },
  { id: 822, tier: 2, country: 'Morocco',       name: 'Coupe du Trone',         timezone: 'UTC+1', active_hours: '15:00-22:00' },

  // ── Oceania Tier 2 ─────────────────────────────────────────────
  { id: 188, tier: 2, country: 'Australia',     name: 'A-League Men',           timezone: 'UTC+10', active_hours: '08:00-16:00' },
  { id: 189, tier: 2, country: 'Australia',     name: 'Australia Cup',          timezone: 'UTC+10', active_hours: '08:00-16:00' },

  // ── Internationale Tier 2 ──────────────────────────────────────
  { id: 848, tier: 2, country: 'International', name: 'UEFA Conference League', timezone: 'UTC+2', active_hours: '16:00-23:00' },
  { id: 5,   tier: 2, country: 'International', name: 'UEFA Nations League',    timezone: 'UTC+2', active_hours: '16:00-23:00' },
  { id: 11,  tier: 2, country: 'International', name: 'Copa Sudamericana',      timezone: 'UTC-3', active_hours: '19:00-02:00' },
  { id: 9,   tier: 2, country: 'International', name: 'Copa America',           timezone: 'UTC-5', active_hours: '19:00-03:00' },
  { id: 10,  tier: 2, country: 'International', name: 'CONCACAF Champions',     timezone: 'UTC-6', active_hours: '20:00-04:00' },
  { id: 17,  tier: 2, country: 'International', name: 'AFC Champions League',   timezone: 'UTC+8', active_hours: '08:00-16:00' },
  { id: 12,  tier: 2, country: 'International', name: 'CAF Champions League',   timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 6,   tier: 2, country: 'International', name: 'FIFA Club World Cup',    timezone: 'UTC+2', active_hours: '14:00-23:00' },

  // ═══════════════════════════════════════════════════════════════
  // TIER 3 — live 2min, 1 endpoint
  // ═══════════════════════════════════════════════════════════════

  // ── Europa Tier 3 ──────────────────────────────────────────────
  { id: 210, tier: 3, country: 'Croatia',       name: 'Prva HNL',               timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 211, tier: 3, country: 'Croatia',       name: 'Druga HNL',              timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 212, tier: 3, country: 'Croatia',       name: 'Croatian Cup',           timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 119, tier: 3, country: 'Denmark',       name: 'Superliga',              timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 120, tier: 3, country: 'Denmark',       name: '1st Division',           timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 123, tier: 3, country: 'Denmark',       name: 'DBU Pokalen',            timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 103, tier: 3, country: 'Norway',        name: 'Eliteserien',            timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 104, tier: 3, country: 'Norway',        name: 'First Division',         timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 105, tier: 3, country: 'Norway',        name: 'Norwegian Cup',          timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 113, tier: 3, country: 'Sweden',        name: 'Allsvenskan',            timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 114, tier: 3, country: 'Sweden',        name: 'Superettan',             timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 115, tier: 3, country: 'Sweden',        name: 'Svenska Cupen',          timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 783, tier: 3, country: 'Romania',       name: 'Superliga',              timezone: 'UTC+3', active_hours: '15:00-22:00' },
  { id: 785, tier: 3, country: 'Romania',       name: 'Liga II',                timezone: 'UTC+3', active_hours: '15:00-22:00' },
  { id: 787, tier: 3, country: 'Romania',       name: 'Cupa Romaniei',          timezone: 'UTC+3', active_hours: '15:00-22:00' },

  // ── America Sud Tier 3 ─────────────────────────────────────────
  { id: 281, tier: 3, country: 'Peru',          name: 'Liga 1',                 timezone: 'UTC-5', active_hours: '19:00-03:00' },
  { id: 282, tier: 3, country: 'Peru',          name: 'Liga 2',                 timezone: 'UTC-5', active_hours: '19:00-03:00' },
  { id: 283, tier: 3, country: 'Peru',          name: 'Copa Peru',              timezone: 'UTC-5', active_hours: '19:00-03:00' },
  { id: 278, tier: 3, country: 'Paraguay',      name: 'Primera Division',       timezone: 'UTC-4', active_hours: '19:00-03:00' },
  { id: 279, tier: 3, country: 'Paraguay',      name: 'Division Intermedia',    timezone: 'UTC-4', active_hours: '19:00-03:00' },
  { id: 280, tier: 3, country: 'Paraguay',      name: 'Copa Paraguay',          timezone: 'UTC-4', active_hours: '19:00-03:00' },
  { id: 273, tier: 3, country: 'Bolivia',       name: 'Primera Division',       timezone: 'UTC-4', active_hours: '19:00-03:00' },
  { id: 274, tier: 3, country: 'Bolivia',       name: 'Liga de Ascenso',        timezone: 'UTC-4', active_hours: '19:00-03:00' },
  { id: 276, tier: 3, country: 'Bolivia',       name: 'Copa Bolivia',           timezone: 'UTC-4', active_hours: '19:00-03:00' },
  { id: 153, tier: 3, country: 'Venezuela',     name: 'Liga FUTVE',             timezone: 'UTC-4', active_hours: '19:00-03:00' },
  { id: 154, tier: 3, country: 'Venezuela',     name: 'Segunda Division',       timezone: 'UTC-4', active_hours: '19:00-03:00' },
  { id: 155, tier: 3, country: 'Venezuela',     name: 'Copa Venezuela',         timezone: 'UTC-4', active_hours: '19:00-03:00' },

  // ── America Nord Tier 3 ────────────────────────────────────────
  { id: 261, tier: 3, country: 'Honduras',      name: 'Liga Nacional',          timezone: 'UTC-6', active_hours: '21:00-04:00' },
  { id: 319, tier: 3, country: 'Honduras',      name: 'Liga de Ascenso',        timezone: 'UTC-6', active_hours: '21:00-04:00' },
  { id: 320, tier: 3, country: 'Honduras',      name: 'Copa Honduras',          timezone: 'UTC-6', active_hours: '21:00-04:00' },
  { id: 339, tier: 3, country: 'Guatemala',     name: 'Liga Nacional',          timezone: 'UTC-6', active_hours: '21:00-04:00' },
  { id: 338, tier: 3, country: 'Guatemala',     name: 'Primera Division',       timezone: 'UTC-6', active_hours: '21:00-04:00' },
  { id: 248, tier: 3, country: 'Guatemala',     name: 'Copa Guatemala',         timezone: 'UTC-6', active_hours: '21:00-04:00' },
  { id: 344, tier: 3, country: 'El Salvador',   name: 'Primera Division',       timezone: 'UTC-6', active_hours: '21:00-04:00' },
  { id: 349, tier: 3, country: 'El Salvador',   name: 'Segunda Division',       timezone: 'UTC-6', active_hours: '21:00-04:00' },
  { id: 350, tier: 3, country: 'El Salvador',   name: 'Copa El Salvador',       timezone: 'UTC-6', active_hours: '21:00-04:00' },
  { id: 256, tier: 3, country: 'Nicaragua',     name: 'Primera Division',       timezone: 'UTC-6', active_hours: '21:00-04:00' },
  { id: 380, tier: 3, country: 'Nicaragua',     name: 'Segunda Division',       timezone: 'UTC-6', active_hours: '21:00-04:00' },

  // ── Asia Tier 3 ────────────────────────────────────────────────
  { id: 433, tier: 3, country: 'UAE',           name: 'UAE Pro League',         timezone: 'UTC+4', active_hours: '15:00-22:00' },
  { id: 434, tier: 3, country: 'UAE',           name: 'First Division',         timezone: 'UTC+4', active_hours: '15:00-22:00' },
  { id: 435, tier: 3, country: 'UAE',           name: 'UAE Cup',                timezone: 'UTC+4', active_hours: '15:00-22:00' },
  { id: 323, tier: 3, country: 'India',         name: 'ISL',                    timezone: 'UTC+5.5', active_hours: '12:00-18:00' },
  { id: 324, tier: 3, country: 'India',         name: 'I-League',               timezone: 'UTC+5.5', active_hours: '12:00-18:00' },
  { id: 325, tier: 3, country: 'India',         name: 'Durand Cup',             timezone: 'UTC+5.5', active_hours: '12:00-18:00' },
  { id: 296, tier: 3, country: 'Thailand',      name: 'Thai League 1',          timezone: 'UTC+7', active_hours: '10:00-17:00' },
  { id: 297, tier: 3, country: 'Thailand',      name: 'Thai League 2',          timezone: 'UTC+7', active_hours: '10:00-17:00' },
  { id: 298, tier: 3, country: 'Thailand',      name: 'Thai FA Cup',            timezone: 'UTC+7', active_hours: '10:00-17:00' },
  { id: 391, tier: 3, country: 'Indonesia',     name: 'Liga 1',                 timezone: 'UTC+7', active_hours: '10:00-17:00' },
  { id: 460, tier: 3, country: 'Indonesia',     name: 'Liga 2',                 timezone: 'UTC+7', active_hours: '10:00-17:00' },
  { id: 461, tier: 3, country: 'Indonesia',     name: 'Indonesian Cup',         timezone: 'UTC+7', active_hours: '10:00-17:00' },

  // ── Africa Tier 3 ──────────────────────────────────────────────
  { id: 197, tier: 3, country: 'Algeria',       name: 'Ligue Pro 1',            timezone: 'UTC+1', active_hours: '15:00-22:00' },
  { id: 198, tier: 3, country: 'Algeria',       name: 'Ligue Pro 2',            timezone: 'UTC+1', active_hours: '15:00-22:00' },
  { id: 199, tier: 3, country: 'Algeria',       name: 'Coupe Algerie',          timezone: 'UTC+1', active_hours: '15:00-22:00' },
  { id: 202, tier: 3, country: 'Tunisia',       name: 'Ligue 1',                timezone: 'UTC+1', active_hours: '15:00-22:00' },
  { id: 377, tier: 3, country: 'Tunisia',       name: 'Ligue 2',                timezone: 'UTC+1', active_hours: '15:00-22:00' },
  { id: 378, tier: 3, country: 'Tunisia',       name: 'Coupe Tunisie',          timezone: 'UTC+1', active_hours: '15:00-22:00' },
  { id: 288, tier: 3, country: 'SouthAfrica',   name: 'PSL',                    timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 670, tier: 3, country: 'SouthAfrica',   name: 'National First Division',timezone: 'UTC+2', active_hours: '15:00-22:00' },
  { id: 671, tier: 3, country: 'SouthAfrica',   name: 'Nedbank Cup',            timezone: 'UTC+2', active_hours: '15:00-22:00' },

  // ── Internationale Tier 3 ──────────────────────────────────────
  { id: 4,   tier: 3, country: 'International', name: 'UEFA Euro',              timezone: 'UTC+2', active_hours: '16:00-23:00' },
  { id: 26,  tier: 3, country: 'International', name: 'CONCACAF Nations League',timezone: 'UTC-6', active_hours: '21:00-04:00' },
  { id: 18,  tier: 3, country: 'International', name: 'AFC Cup',                timezone: 'UTC+8', active_hours: '08:00-16:00' },
  { id: 20,  tier: 3, country: 'International', name: 'CAF Confederation',      timezone: 'UTC+2', active_hours: '15:00-22:00' },
];

// ─── HELPER FUNCTIONS ───────────────────────────────────────────────────────

export const getLeaguesByTier = (tier) =>
  LEAGUES.filter(l => l.tier === tier);

// Verifică dacă ora curentă (Germania, UTC+2) e în intervalul activ al ligii
// Suportă intervale care trec peste miezul noptii (ex: 23:00-02:00)
const isHourInRange = (hour, active_hours) => {
  const [startStr, endStr] = active_hours.split('-');
  const start = parseInt(startStr.split(':')[0], 10);
  const end   = parseInt(endStr.split(':')[0], 10);
  if (start <= end) {
    return hour >= start && hour < end;
  } else {
    return hour >= start || hour < end;
  }
};

export const getActiveLeagues = (currentHour) =>
  LEAGUES.filter(l => isHourInRange(currentHour, l.active_hours));

export const isLeagueActive = (leagueId, currentHour) => {
  const league = LEAGUES.find(l => l.id === leagueId);
  return league ? isHourInRange(currentHour, league.active_hours) : false;
};

export const getLeaguesByWindow = (currentHour) => {
  if (currentHour >= 6  && currentHour < 12) return getActiveLeagues(currentHour); // WINDOW_1 Asia
  if (currentHour >= 12 && currentHour < 16) return getActiveLeagues(currentHour); // WINDOW_2 Asia tarzie
  if (currentHour >= 16 && currentHour < 23) return getActiveLeagues(currentHour); // WINDOW_3 Europa PEAK
  if (currentHour >= 23 || currentHour < 2)  return getActiveLeagues(currentHour); // WINDOW_4 America Nord/Sud
  return getActiveLeagues(currentHour);                                              // WINDOW_5 Minim
};

export const TIER1_IDS = getLeaguesByTier(1).map(l => l.id);
export const TIER2_IDS = getLeaguesByTier(2).map(l => l.id);
export const TIER3_IDS = getLeaguesByTier(3).map(l => l.id);

// Backward compatibility cu restul codului
export const ALLOWED_LEAGUE_IDS = new Set(LEAGUES.map(l => l.id));
