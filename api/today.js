import { ALLOWED_LEAGUE_IDS } from './leagues.js';
import { query } from './db.js';

function log(msg) {
  console.log(`[today] ${new Date().toISOString()} ${msg}`);
}

const WOMEN_RE    = /women|feminin|femenin|ladies|female|w league|nwsl|wsl/i;
const LOWER_DIV_RE = /\b[3-9]\.\s*(liga|division|div)\b/i;

function dateStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

async function getFixturesFromDB() {
  try {
    const now  = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const r = await query(
      `SELECT f.fixture_id AS id, f.match_date AS kickoff_time, f.status_short, f.status_long,
              f.league_id, f.home_team_id, f.away_team_id,
              COALESCE(th.name, f.home_team_name) AS home_team_name, th.logo AS home_logo,
              COALESCE(ta.name, f.away_team_name) AS away_team_name, ta.logo AS away_logo
       FROM fixtures f
       LEFT JOIN teams th ON th.team_id = f.home_team_id
       LEFT JOIN teams ta ON ta.team_id = f.away_team_id
       WHERE f.status_short = 'NS'
         AND f.match_date >= $1 AND f.match_date <= $2
       ORDER BY f.match_date ASC`,
      [now.toISOString(), in24h.toISOString()]
    );
    return r.rows;
  } catch (_) { return []; }
}

async function getLeaguesFromDB(leagueIds) {
  try {
    if (!leagueIds.length) return [];
    const r = await query(
      'SELECT league_id AS id, name, country, logo FROM leagues WHERE league_id = ANY($1)',
      [leagueIds]
    );
    return r.rows;
  } catch (_) { return []; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=30');

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;

  // --- Snapshots action ---
  const action = (req.query && req.query.action) ||
    new URL(req.url || '', 'http://localhost').searchParams.get('action');
  if (action === 'snapshots') {
    // pre_match_snapshots schema does not have composite_score or outcome columns
    return res.status(200).json({ snapshots: [] });
  }

  if (!key) {
    log('ERROR: no API-Football key configured');
    return res.status(200).json({ response: [], error: 'API key not configured' });
  }

  try {
    // --- Try PostgreSQL first ---
    const dbFixtures = await getFixturesFromDB();
    log(`db fixtures: ${dbFixtures.length}`);

    if (dbFixtures.length >= 5) {
      const afterLeague = dbFixtures.filter(f => ALLOWED_LEAGUE_IDS.has(f.league_id));
      log(`after league filter (db): ${afterLeague.length}`);

      const leagueIds = [...new Set(afterLeague.map(f => f.league_id))];
      const leagueRows = await getLeaguesFromDB(leagueIds);
      const leagueMap  = Object.fromEntries((leagueRows || []).map(l => [l.id, l]));

      const raw = afterLeague.map(f => {
        const lg = leagueMap[f.league_id] || {};
        return {
          fixture: { id: f.id, date: f.kickoff_time, status: { short: f.status_short, long: f.status_long } },
          league:  { id: f.league_id, name: lg.name || '', country: lg.country || '', flag: lg.logo || '' },
          teams:   { home: { id: f.home_team_id, name: f.home_team_name, logo: f.home_logo || null },
                     away: { id: f.away_team_id, name: f.away_team_name, logo: f.away_logo || null } },
          goals:   { home: null, away: null },
        };
      });

      const afterWomen = raw.filter(m => !WOMEN_RE.test(m.league?.name || ''));
      const afterDiv   = afterWomen.filter(m => !LOWER_DIV_RE.test(m.league?.name || ''));

      log(`final (db): ${afterDiv.length}`);

      return res.status(200).json({
        response: afterDiv.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date)),
        _debug: {
          source:        'postgres',
          rawTotal:      dbFixtures.length,
          afterLeague:   afterLeague.length,
          afterWomen:    afterWomen.length,
          afterLowerDiv: afterDiv.length,
          final:         afterDiv.length,
        },
      });
    }

    // --- Fallback: API-Football ---
    log('db insufficient, falling back to API-Football');
    const [d0, d1] = [dateStr(0), dateStr(1)];
    log(`fetching 2 days: ${d0} / ${d1}`);

    const hdr  = { 'x-apisports-key': key };
    const base = 'https://v3.football.api-sports.io/fixtures';

    const [r0, r1] = await Promise.all([
      fetch(`${base}?date=${d0}&status=NS&timezone=UTC`, { headers: hdr }),
      fetch(`${base}?date=${d1}&status=NS&timezone=UTC`, { headers: hdr }),
    ]);

    const [j0, j1] = await Promise.all([r0.json(), r1.json()]);

    if (j0.errors && Object.keys(j0.errors).length > 0) {
      const errMsg = JSON.stringify(j0.errors);
      log(`API errors: ${errMsg}`);
      return res.status(200).json({ response: [], error: errMsg });
    }

    const counts = {
      day0: Array.isArray(j0.response) ? j0.response.length : 0,
      day1: Array.isArray(j1.response) ? j1.response.length : 0,
    };
    log(`raw per day: ${d0}=${counts.day0} ${d1}=${counts.day1}`);

    const now    = Date.now();
    const cutoff = now + 24 * 60 * 60 * 1000;
    const seen   = new Set();
    const raw    = [
      ...(j0.response || []),
      ...(j1.response || []),
    ].filter(m => {
      if (!m.fixture?.id || seen.has(m.fixture.id)) return false;
      seen.add(m.fixture.id);
      const kickoff = new Date(m.fixture.date).getTime();
      return kickoff >= now && kickoff <= cutoff;
    });
    log(`raw total (deduped, 24h window): ${raw.length}`);

    const afterLeague = raw.filter(m => ALLOWED_LEAGUE_IDS.has(m.league?.id));
    log(`after league filter: ${afterLeague.length} (removed ${raw.length - afterLeague.length})`);

    const afterWomen = afterLeague.filter(m => !WOMEN_RE.test(m.league?.name || ''));
    log(`after women filter: ${afterWomen.length} (removed ${afterLeague.length - afterWomen.length})`);

    const afterDiv = afterWomen.filter(m => !LOWER_DIV_RE.test(m.league?.name || ''));
    log(`after lower-div filter: ${afterDiv.length} (removed ${afterWomen.length - afterDiv.length})`);

    const result = afterDiv
      .map(m => ({
        fixture: { id: m.fixture.id, date: m.fixture.date, status: m.fixture.status },
        league:  { id: m.league.id, name: m.league.name, country: m.league.country, flag: m.league.flag },
        teams:   { home: { id: m.teams.home.id, name: m.teams.home.name },
                   away: { id: m.teams.away.id, name: m.teams.away.name } },
        goals:   { home: m.goals.home, away: m.goals.away },
      }))
      .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

    log(`final: ${result.length} matches`);

    return res.status(200).json({
      response: result,
      _debug: {
        source:        'api-football',
        days:          [d0, d1],
        window:        '24h',
        rawPerDay:     counts,
        rawTotal:      raw.length,
        afterLeague:   afterLeague.length,
        afterWomen:    afterWomen.length,
        afterLowerDiv: afterDiv.length,
        final:         result.length,
      },
    });

  } catch (e) {
    log(`ERROR: ${e.message}`);
    return res.status(200).json({ response: [], error: e.message });
  }
}
