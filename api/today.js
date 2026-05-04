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

  const now     = Date.now();
  const cutoff  = now + 48 * 60 * 60 * 1000;
  const todayStr    = new Date(now).toISOString().split('T')[0];
  const tomorrowStr = new Date(now + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  log(`window: ${todayStr} → ${tomorrowStr} (48h), key present=${!!key}`);

  try {
    const hdr = { 'x-apisports-key': key };

    // Fetch today and tomorrow in parallel
    const [r1, r2] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/fixtures?date=${todayStr}`,    { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures?date=${tomorrowStr}`, { headers: hdr }),
    ]);

    if (!r1.ok) {
      log(`API error HTTP ${r1.status}`);
      return res.status(200).json({ response: [], error: `Upstream HTTP ${r1.status}` });
    }

    const [d1, d2] = await Promise.all([r1.json(), r2.ok ? r2.json() : Promise.resolve({ response: [] })]);

    if (d1.errors && Object.keys(d1.errors).length > 0) {
      const errMsg = JSON.stringify(d1.errors);
      log(`API errors: ${errMsg}`);
      return res.status(200).json({ response: [], error: errMsg });
    }

    // Combine + deduplicate by fixture id
    const seen = new Set();
    const raw = [
      ...(Array.isArray(d1.response) ? d1.response : []),
      ...(Array.isArray(d2.response) ? d2.response : []),
    ].filter(m => {
      if (!m.fixture?.id || seen.has(m.fixture.id)) return false;
      seen.add(m.fixture.id);
      return true;
    });

    log(`Total raw: ${raw.length} (today=${d1.response?.length ?? 0}, tomorrow=${d2.response?.length ?? 0})`);

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

    // Filter 2: NS (Not Started) and kickoff within the 48h window
    const afterStatus = afterLeague.filter(m => {
      if (m.fixture?.status?.short !== 'NS') return false;
      const fd = new Date(m.fixture.date).getTime();
      return fd >= now && fd <= cutoff;
    });
    log(`After NS+48h filter: ${afterStatus.length} (removed ${afterLeague.length - afterStatus.length})`);

    // Map to slim payload and sort by kickoff — no count limit
    const result = afterStatus
      .map(m => ({
        fixture: { id: m.fixture.id, date: m.fixture.date, status: m.fixture.status },
        league:  { id: m.league.id, name: m.league.name, country: m.league.country, flag: m.league.flag },
        teams:   { home: { id: m.teams.home.id, name: m.teams.home.name },
                   away: { id: m.teams.away.id, name: m.teams.away.name } },
        goals:   { home: m.goals.home, away: m.goals.away },
      }))
      .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

    log(`Final response: ${result.length} matches`);
    return res.status(200).json({
      response: result,
      _debug: { raw: raw.length, afterLeague: afterLeague.length, afterStatus: afterStatus.length, byStatus, window: `${todayStr}→${tomorrowStr}` },
    });

  } catch (e) {
    log(`ERROR: ${e.message}`);
    return res.status(200).json({ response: [], error: e.message });
  }
}
