import { ALLOWED_LEAGUE_IDS } from './leagues.js';

function log(msg) {
  console.log(`[today] ${new Date().toISOString()} ${msg}`);
}

const WOMEN_RE = /women|feminin|femenin|ladies|female|w league|nwsl|wsl/i;

function dateStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=30');

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) {
    log('ERROR: no API-Football key configured');
    return res.status(200).json({ response: [], error: 'API key not configured' });
  }

  const [d0, d1] = [dateStr(0), dateStr(1)];
  log(`fetching 2 days: ${d0} / ${d1}`);

  try {
    const hdr = { 'x-apisports-key': key };
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

    // Combine + deduplicate by fixture.id
    const now = Date.now();
    const cutoff = now + 24 * 60 * 60 * 1000; // exactly 24h from now
    const seen = new Set();
    const raw = [
      ...(j0.response || []),
      ...(j1.response || []),
    ].filter(m => {
      if (!m.fixture?.id || seen.has(m.fixture.id)) return false;
      seen.add(m.fixture.id);
      // Keep only matches starting within the next 24 hours
      const kickoff = new Date(m.fixture.date).getTime();
      return kickoff >= now && kickoff <= cutoff;
    });
    log(`raw total (deduped, 24h window): ${raw.length}`);

    // Filter: league whitelist
    const afterLeague = raw.filter(m => ALLOWED_LEAGUE_IDS.has(m.league?.id));
    log(`after league filter: ${afterLeague.length} (removed ${raw.length - afterLeague.length})`);

    // Filter: remove women's leagues
    const afterWomen = afterLeague.filter(m => !WOMEN_RE.test(m.league?.name || ''));
    log(`after women filter: ${afterWomen.length} (removed ${afterLeague.length - afterWomen.length})`);

    // Map to slim payload, sort by kickoff ascending — no count limit
    const result = afterWomen
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
        days: [d0, d1],
        window: '24h',
        rawPerDay: counts,
        rawTotal: raw.length,
        afterLeague: afterLeague.length,
        afterWomen: afterWomen.length,
        final: result.length,
      },
    });

  } catch (e) {
    log(`ERROR: ${e.message}`);
    return res.status(200).json({ response: [], error: e.message });
  }
}
