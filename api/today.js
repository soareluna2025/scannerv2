function log(msg) {
  console.log(`[today] ${new Date().toISOString()} ${msg}`);
}

const enrichCache = new Map();

async function enrichMatch(fixtureId, homeId, awayId, apiKey) {
  if (enrichCache.has(fixtureId)) return;
  try {
    const hdr = { 'x-apisports-key': apiKey };
    const [r1, r2, r3] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures?team=${homeId}&last=20&status=FT`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures?team=${awayId}&last=20&status=FT`, { headers: hdr })
    ]);
    const [d1, d2, d3] = await Promise.all([r1.json(), r2.json(), r3.json()]);
    const h2h    = (d1.response || []).slice(0, 10);
    const hGames = (d2.response || []).filter(m => m.teams?.home?.id === homeId).slice(0, 10);
    const aGames = (d3.response || []).filter(m => m.teams?.away?.id === awayId).slice(0, 10);
    const pct = (arr, fn) => arr.length ? Math.round(arr.filter(fn).length / arr.length * 100) : null;
    enrichCache.set(fixtureId, {
      homeScoreRate: pct(hGames, m => (m.goals?.home ?? 0) > 0),
      awayScoreRate: pct(aGames, m => (m.goals?.away ?? 0) > 0),
      h2hOver15:     pct(h2h,   m => ((m.goals?.home ?? 0) + (m.goals?.away ?? 0)) > 1),
      h2hGG:         pct(h2h,   m => (m.goals?.home ?? 0) > 0 && (m.goals?.away ?? 0) > 0),
      h2hSample:     h2h.length
    });
  } catch (e) {
    log(`enrich ${fixtureId}: ${e.message}`);
  }
}

const WOMEN_RE = /women|feminin|femenin|ladies|female|w league|nwsl|wsl/i;
const BATCH_SIZE = 20;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

    // Enrich in batches of 20 with 200ms pause between batches
    const toEnrich = upcoming.filter(
      m => m.teams?.home?.id && m.teams?.away?.id && !enrichCache.has(m.fixture.id)
    );
    if (toEnrich.length > 0) {
      log(`enriching ${toEnrich.length} fixtures in batches of ${BATCH_SIZE}`);
      for (let i = 0; i < toEnrich.length; i += BATCH_SIZE) {
        const batch = toEnrich.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(m =>
          enrichMatch(m.fixture.id, m.teams.home.id, m.teams.away.id, key)
        ));
        if (i + BATCH_SIZE < toEnrich.length) await sleep(200);
      }
    }

    for (const m of upcoming) {
      m.enrichData = enrichCache.get(m.fixture.id) || null;
    }

    return res.status(200).json({ response: upcoming });

  } catch (e) {
    log(`ERROR: ${e.message}`);
    return res.status(200).json({ response: [], error: e.message });
  }
}
