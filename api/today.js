function log(msg) {
  console.log(`[today] ${new Date().toISOString()} ${msg}`);
}

const LIVE_STATUS = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT', 'NS']);
const NOT_STARTED = 'NS';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=30');

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) {
    log('ERROR: no API-Football key configured');
    return res.status(200).json({ response: [], error: 'API key not configured' });
  }

  // Today's date in YYYY-MM-DD format (UTC)
  const today = new Date().toISOString().split('T')[0];
  const nowMs = Date.now();
  const threeHoursMs = 3 * 60 * 60 * 1000;

  try {
    log(`fetching today's fixtures for ${today}`);
    const r = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${today}&status=NS`,
      { headers: { 'x-apisports-key': key } }
    );

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
    log(`raw fixtures: ${raw.length}`);

    // Keep only matches starting within the next 3 hours
    const upcoming = raw.filter(m => {
      const fixtureDate = m.fixture?.date;
      if (!fixtureDate) return false;
      const fixtureMs = new Date(fixtureDate).getTime();
      return fixtureMs >= nowMs && fixtureMs <= nowMs + threeHoursMs;
    });

    log(`upcoming (next 3h): ${upcoming.length}`);
    return res.status(200).json({ response: upcoming });

  } catch (e) {
    log(`ERROR: ${e.message}`);
    return res.status(200).json({ response: [], error: e.message });
  }
}
