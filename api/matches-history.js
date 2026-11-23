// GET /api/matches-history?date=YYYY-MM-DD
// Calendar + Istoric meciuri — orice dată (trecut / azi / viitor).
//
// Branching:
//   date < azi → fixtures_history (status_short='FT')
//   date = azi → MERGE fixtures_history (terminate) + fixtures (restul zilei), dedup pe fixture_id
//   date > azi → fixtures (status_short NS/TBD/PST)
//
// Filtru: doar ligile din ALLOWED_LEAGUE_IDS.
// Grupare în răspuns: { groups: [{country, league_name, league_id, matches:[]}] }

import { query } from './db.js';
import { ALLOWED_LEAGUE_IDS } from './leagues.js';

const LOGO_BASE = 'https://media.api-sports.io/football/teams/';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const dateParam = String(req.query?.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return res.status(400).json({ ok: false, error: 'date param required: YYYY-MM-DD' });
  }

  const allowedIds = [...ALLOWED_LEAGUE_IDS];
  const today = new Date().toISOString().slice(0, 10);
  const isPast  = dateParam < today;
  const isToday = dateParam === today;

  // Construiește query-ul pentru o sursă dată. fixtures_history NU are coloana `round`
  // (scripts/create-tables.sql) → NULL placeholder pe ramura istorică.
  const buildSql = (source) => {
    const roundExpr = source === 'fixtures_history' ? 'NULL::TEXT' : 'f.round';
    let extraWhere = '';
    if (source === 'fixtures_history') extraWhere = "AND f.status_short IN ('FT','AET','PEN')";
    else if (!isToday)                 extraWhere = "AND f.status_short IN ('NS','TBD','PST')";
    return `
      SELECT f.fixture_id,
             f.home_team_name, f.away_team_name,
             f.home_team_id,   f.away_team_id,
             f.home_goals,     f.away_goals,
             f.status_short,   f.match_date,
             f.league_id,      ${roundExpr} AS round,
             l.name    AS league_name,
             l.country AS country,
             th.logo   AS home_logo,
             ta.logo   AS away_logo
        FROM ${source} f
        JOIN leagues l ON l.league_id = f.league_id
        LEFT JOIN teams th ON th.team_id = f.home_team_id
        LEFT JOIN teams ta ON ta.team_id = f.away_team_id
       WHERE f.match_date::date = $1
         AND f.league_id = ANY($2)
         ${extraWhere}
       ORDER BY l.country, l.name, f.match_date
    `;
  };

  try {
    let sourceTable, rows;
    if (isPast) {
      // Trecut → fixtures_history (FT/AET/PEN).
      sourceTable = 'fixtures_history';
      ({ rows } = await query(buildSql(sourceTable), [dateParam, allowedIds]));
    } else if (isToday) {
      // Azi → MERGE: meciurile deja terminate (fixtures_history, scor real) + cele rămase
      // (fixtures: NS/LIVE/etc.). Înainte, dacă existau ≥1 meciuri terminate azi, se returnau
      // DOAR ele și restul zilei dispărea din calendar. Dedup pe fixture_id, istoricul are prioritate.
      const hist = await query(buildSql('fixtures_history'), [dateParam, allowedIds]);
      const fut  = await query(buildSql('fixtures'),         [dateParam, allowedIds]);
      const seen = new Set(hist.rows.map(r => r.fixture_id));
      rows = [...hist.rows, ...fut.rows.filter(r => !seen.has(r.fixture_id))];
      rows.sort((a, b) =>
        String(a.country || '').localeCompare(String(b.country || '')) ||
        String(a.league_name || '').localeCompare(String(b.league_name || '')) ||
        new Date(a.match_date) - new Date(b.match_date));
      sourceTable = fut.rows.length ? (hist.rows.length ? 'fixtures_history+fixtures' : 'fixtures') : 'fixtures_history';
    } else {
      // Viitor → fixtures (NS/TBD/PST).
      sourceTable = 'fixtures';
      ({ rows } = await query(buildSql(sourceTable), [dateParam, allowedIds]));
    }

    const groups = new Map();
    for (const r of rows) {
      const key = `${r.country}__${r.league_name}__${r.league_id}`;
      if (!groups.has(key)) {
        groups.set(key, {
          country:     r.country     || '',
          league_id:   r.league_id,
          league_name: r.league_name || '',
          matches: [],
        });
      }
      groups.get(key).matches.push({
        fixture_id:   r.fixture_id,
        home_team_id: r.home_team_id,
        away_team_id: r.away_team_id,
        home_team:    r.home_team_name,
        away_team:    r.away_team_name,
        home_logo:    r.home_logo || (r.home_team_id ? `${LOGO_BASE}${r.home_team_id}.png` : null),
        away_logo:    r.away_logo || (r.away_team_id ? `${LOGO_BASE}${r.away_team_id}.png` : null),
        home_goals:   r.home_goals,
        away_goals:   r.away_goals,
        status_short: r.status_short,
        match_date:   r.match_date,
        round:        r.round || null,
      });
    }

    return res.json({
      ok: true,
      date:   dateParam,
      source: sourceTable,
      count:  rows.length,
      groups: [...groups.values()],
    });
  } catch (e) {
    console.error('[matches-history]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
