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
  const nowMs = Date.now();
  const in24h = nowMs + 24 * 60 * 60 * 1000;

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

    const upcoming = raw
      .filter(m => {
        if (WOMEN_RE.test(m.league?.name || '')) return false;
        const fixtureMs = new Date(m.fixture?.date).getTime();
        return fixtureMs >= nowMs && fixtureMs <= in24h;
      })
      .map(m => ({
        fixture: {
          id:     m.fixture.id,
          date:   m.fixture.date,
          status: m.fixture.status
        },
        league: {
          id:      m.league.id,
          name:    m.league.name,
          country: m.league.country,
          flag:    m.league.flag
        },
        teams: {
          home: { id: m.teams.home.id, name: m.teams.home.name },
          away: { id: m.teams.away.id, name: m.teams.away.name }
        },
        goals: { home: m.goals.home, away: m.goals.away }
      }));

    log(`upcoming after filter: ${upcoming.length}`);
    return res.status(200).json({ response: upcoming });

  } catch (e) {
    log(`ERROR: ${e.message}`);
    return res.status(200).json({ response: [], error: e.message });
  }
}
