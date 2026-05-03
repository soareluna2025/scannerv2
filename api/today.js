import { ALLOWED_LEAGUE_IDS } from './leagues.js';

function log(msg) {
  console.log(`[today] ${new Date().toISOString()} ${msg}`);
}

const WOMEN_RE = /women|feminin|femenin|ladies|female|w league|nwsl|wsl/i;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=30');

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) {
    log('ERROR: no API-Football key configured');
    return res.status(200).json({ response: [], error: 'API key not configured' });
  }

  const today = new Date().toISOString().split('T')[0];
  log(`date=${today}, key present=${!!key}`);

  try {
    const url = `https://v3.football.api-sports.io/fixtures?date=${today}`;
    log(`fetching: ${url}`);

    const r = await fetch(url, { headers: { 'x-apisports-key': key } });
    if (!r.ok) {
      log(`API error HTTP ${r.status}`);
      return res.status(200).json({ response: [], error: `Upstream HTTP ${r.status}` });
    }

    const data = await r.json();

    if (data.errors && Object.keys(data.errors).length > 0) {
      const errMsg = JSON.stringify(data.errors);
      log(`API errors: ${errMsg}`);
      return res.status(200).json({ response: [], error: errMsg });
    }

    const raw = Array.isArray(data.response) ? data.response : [];
    log(`Total raw: ${raw.length}`);

    // Count by status before filtering
    const byStatus = {};
    raw.forEach(m => {
      const s = m.fixture?.status?.short || 'unknown';
      byStatus[s] = (byStatus[s] || 0) + 1;
    });
    log(`Status breakdown: ${JSON.stringify(byStatus)}`);

    // Filter 1: strict league whitelist + women exclusion
    const afterLeague = raw.filter(m =>
      ALLOWED_LEAGUE_IDS.has(m.league?.id) && !WOMEN_RE.test(m.league?.name || '')
    );
    log(`After league filter: ${afterLeague.length} (removed ${raw.length - afterLeague.length})`);

    // Filter 2: only NS (Not Started) — keep pre-match only
    const afterStatus = afterLeague.filter(m => m.fixture?.status?.short === 'NS');
    log(`After NS filter: ${afterStatus.length} (removed ${afterLeague.length - afterStatus.length})`);

    const result = afterStatus.map(m => ({
      fixture: { id: m.fixture.id, date: m.fixture.date, status: m.fixture.status },
      league:  { id: m.league.id, name: m.league.name, country: m.league.country, flag: m.league.flag },
      teams:   { home: { id: m.teams.home.id, name: m.teams.home.name },
                 away: { id: m.teams.away.id, name: m.teams.away.name } },
      goals:   { home: m.goals.home, away: m.goals.away }
    }));

    log(`Final response: ${result.length} matches`);
    return res.status(200).json({ response: result, _debug: { raw: raw.length, afterLeague: afterLeague.length, afterStatus: afterStatus.length, byStatus } });

  } catch (e) {
    log(`ERROR: ${e.message}`);
    return res.status(200).json({ response: [], error: e.message });
  }
}
