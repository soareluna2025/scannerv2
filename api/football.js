// In-memory cache to limit API-Football calls (55s TTL)
let _cache = { data: null, ts: 0 };
const CACHE_TTL = 55_000;

const LIVE_STATUS = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT']);

function log(msg) {
  console.log(`[football] ${new Date().toISOString()} ${msg}`);
}

function getStat(statistics, teamIdx, type) {
  const team = statistics?.[teamIdx]?.statistics;
  if (!Array.isArray(team)) return 0;
  const entry = team.find(s => s.type === type);
  const v = entry?.value;
  if (v === null || v === undefined || v === 'N/A' || v === '') return 0;
  return parseFloat(v) || 0;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=55, stale-while-revalidate=10');

  const key = process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) {
    log('ERROR: no API-Football key configured');
    return res.status(200).json({ response: [], error: 'API key not configured (set APIFOOTBALL_KEY or API_FOOTBALL_KEY in Vercel)' });
  }

  // Return cached response if still fresh
  const now = Date.now();
  if (_cache.data && now - _cache.ts < CACHE_TTL) {
    log(`cache hit (${Math.round((now - _cache.ts) / 1000)}s old)`);
    return res.status(200).json(_cache.data);
  }

  try {
    log('fetching live fixtures from API-Football');
    const r = await fetch('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: { 'x-apisports-key': key }
    });

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
    log(`raw fixtures from API: ${raw.length}`);

    const validated = raw
      .filter(m => {
        const sh      = m.fixture?.status?.short || '';
        const elapsed = m.fixture?.status?.elapsed || 0;
        const stats   = m.statistics || [];

        // Must be a live status
        if (!LIVE_STATUS.has(sh)) return false;
        // Must have started
        if (elapsed < 1) return false;
        // Must have statistics (proves match is genuinely in progress)
        if (stats.length === 0) return false;

        return true;
      })
      .map(m => {
        const stats   = m.statistics || [];
        const elapsed = m.fixture.status.elapsed;

        // Extract all relevant statistics
        const hSOT = getStat(stats, 0, 'Shots on Goal');
        const aSOT = getStat(stats, 1, 'Shots on Goal');
        const hSoff = getStat(stats, 0, 'Shots off Goal');
        const aSoff = getStat(stats, 1, 'Shots off Goal');
        const hDA   = getStat(stats, 0, 'Dangerous Attacks');
        const aDA   = getStat(stats, 1, 'Dangerous Attacks');
        const hC    = getStat(stats, 0, 'Corner Kicks');
        const aC    = getStat(stats, 1, 'Corner Kicks');

        // Server-side stale data filter:
        // After 10 minutes, if shots + dangerous attacks + corners are all 0 → stale/ghost
        if (elapsed > 10) {
          const activity = hSOT + aSOT + hSoff + aSoff + hDA + aDA + hC + aC;
          if (activity === 0) return null;
        }

        // Extract xG — MEGA plan includes this; return 0 if null/missing
        const hxg = getStat(stats, 0, 'expected_goals');
        const axg = getStat(stats, 1, 'expected_goals');

        return {
          _src: 'af',
          _validated: true,
          fixture: {
            id:     m.fixture.id,
            date:   m.fixture.date,
            status: {
              short:   m.fixture.status.short,
              long:    m.fixture.status.long,
              elapsed: elapsed
            }
          },
          league: {
            id:      m.league.id,
            name:    m.league.name,
            country: m.league.country,
            logo:    m.league.logo,
            flag:    m.league.flag,
            f:       m.league.country || '🌐'
          },
          teams: {
            home: {
              id:   m.teams.home.id,
              name: m.teams.home.name,
              logo: m.teams.home.logo
            },
            away: {
              id:   m.teams.away.id,
              name: m.teams.away.name,
              logo: m.teams.away.logo
            }
          },
          goals: {
            home: m.goals.home ?? 0,
            away: m.goals.away ?? 0
          },
          // Pre-extracted xG (0 if not available — never fabricated)
          xg: { home: hxg, away: axg },
          statistics: stats,
          events:     m.events   || [],
          lineups:    m.lineups  || []
        };
      })
      .filter(Boolean); // remove nulls from stale data filter

    log(`validated fixtures: ${validated.length} (filtered ${raw.length - validated.length})`);

    const result = { response: validated };
    _cache = { data: result, ts: now };
    return res.status(200).json(result);

  } catch (e) {
    log(`ERROR: ${e.message}`);
    // Return empty rather than 500 so frontend handles gracefully
    return res.status(200).json({ response: [], error: e.message });
  }
}
