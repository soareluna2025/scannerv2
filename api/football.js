// In-memory cache to limit API-Football calls (55s TTL)
let _cache = { data: null, ts: 0 };
const CACHE_TTL = 55_000;

// Per-fixture enrich cache (persists across requests on same instance)
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

const COUNTRY_FLAG = {
  'Afghanistan': '🇦🇫', 'Albania': '🇦🇱', 'Algeria': '🇩🇿', 'Angola': '🇦🇴',
  'Argentina': '🇦🇷', 'Armenia': '🇦🇲', 'Australia': '🇦🇺', 'Austria': '🇦🇹',
  'Azerbaijan': '🇦🇿', 'Bahrain': '🇧🇭', 'Bangladesh': '🇧🇩', 'Belarus': '🇧🇾',
  'Belgium': '🇧🇪', 'Bolivia': '🇧🇴', 'Bosnia': '🇧🇦', 'Brazil': '🇧🇷',
  'Bulgaria': '🇧🇬', 'Cambodia': '🇰🇭', 'Cameroon': '🇨🇲', 'Canada': '🇨🇦',
  'Chile': '🇨🇱', 'China': '🇨🇳', 'Colombia': '🇨🇴', 'Congo': '🇨🇬',
  'Costa Rica': '🇨🇷', 'Croatia': '🇭🇷', 'Cyprus': '🇨🇾', 'Czech Republic': '🇨🇿',
  'Czechia': '🇨🇿', 'Denmark': '🇩🇰', 'Ecuador': '🇪🇨', 'Egypt': '🇪🇬',
  'El Salvador': '🇸🇻', 'England': '🏴󠁧󠁢󠁥󠁮󠁧󠁿', 'Estonia': '🇪🇪', 'Ethiopia': '🇪🇹',
  'Finland': '🇫🇮', 'France': '🇫🇷', 'Georgia': '🇬🇪', 'Germany': '🇩🇪',
  'Ghana': '🇬🇭', 'Greece': '🇬🇷', 'Guatemala': '🇬🇹', 'Honduras': '🇭🇳',
  'Hungary': '🇭🇺', 'Iceland': '🇮🇸', 'India': '🇮🇳', 'Indonesia': '🇮🇩',
  'Iran': '🇮🇷', 'Iraq': '🇮🇶', 'Ireland': '🇮🇪', 'Israel': '🇮🇱',
  'Italy': '🇮🇹', 'Ivory Coast': '🇨🇮', 'Jamaica': '🇯🇲', 'Japan': '🇯🇵',
  'Jordan': '🇯🇴', 'Kazakhstan': '🇰🇿', 'Kenya': '🇰🇪', 'Kuwait': '🇰🇼',
  'Latvia': '🇱🇻', 'Lebanon': '🇱🇧', 'Libya': '🇱🇾', 'Lithuania': '🇱🇹',
  'Luxembourg': '🇱🇺', 'Malaysia': '🇲🇾', 'Mexico': '🇲🇽', 'Moldova': '🇲🇩',
  'Montenegro': '🇲🇪', 'Morocco': '🇲🇦', 'Netherlands': '🇳🇱', 'New Zealand': '🇳🇿',
  'Nicaragua': '🇳🇮', 'Nigeria': '🇳🇬', 'North Korea': '🇰🇵', 'North Macedonia': '🇲🇰',
  'Norway': '🇳🇴', 'Oman': '🇴🇲', 'Pakistan': '🇵🇰', 'Palestine': '🇵🇸',
  'Panama': '🇵🇦', 'Paraguay': '🇵🇾', 'Peru': '🇵🇪', 'Philippines': '🇵🇭',
  'Poland': '🇵🇱', 'Portugal': '🇵🇹', 'Qatar': '🇶🇦', 'Romania': '🇷🇴',
  'Russia': '🇷🇺', 'Saudi Arabia': '🇸🇦', 'Scotland': '🏴󠁧󠁢󠁳󠁣󠁴󠁿', 'Senegal': '🇸🇳',
  'Serbia': '🇷🇸', 'Singapore': '🇸🇬', 'Slovakia': '🇸🇰', 'Slovenia': '🇸🇮',
  'South Africa': '🇿🇦', 'South Korea': '🇰🇷', 'Spain': '🇪🇸', 'Sudan': '🇸🇩',
  'Sweden': '🇸🇪', 'Switzerland': '🇨🇭', 'Syria': '🇸🇾', 'Taiwan': '🇹🇼',
  'Thailand': '🇹🇭', 'Tunisia': '🇹🇳', 'Turkey': '🇹🇷', 'USA': '🇺🇸',
  'Ukraine': '🇺🇦', 'United Arab Emirates': '🇦🇪', 'United States': '🇺🇸',
  'Uruguay': '🇺🇾', 'Uzbekistan': '🇺🇿', 'Venezuela': '🇻🇪', 'Vietnam': '🇻🇳',
  'Wales': '🏴󠁧󠁢󠁷󠁬󠁳󠁿', 'Zambia': '🇿🇲', 'Zimbabwe': '🇿🇼',
  'World': '🌍', 'Europe': '🇪🇺', 'Africa': '🌍', 'Asia': '🌏',
  'South America': '🌎', 'North America': '🌎', 'CONCACAF': '🌎', 'UEFA': '🇪🇺',
  'CAF': '🌍', 'AFC': '🌏', 'CONMEBOL': '🌎', 'OFC': '🌏',
};
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

function norm(n) { return (n || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Estimate elapsed minutes when API returns null (free-tier limitation)
function estimateElapsed(fixtureDate, statusShort) {
  if (!fixtureDate) return 0;
  const kickoffMs = new Date(fixtureDate).getTime();
  const nowMs     = Date.now();
  const totalMins = Math.max(0, Math.floor((nowMs - kickoffMs) / 60000));

  switch (statusShort) {
    case '1H':  return Math.min(45, totalMins);
    case 'HT':  return 45;
    case '2H':  return Math.min(90, Math.max(46, totalMins - 15)); // ~15min halftime break
    case 'ET':  return Math.min(120, Math.max(91, totalMins - 30));
    case 'BT':  return 105; // break between ET halves
    case 'P':   return 120;
    default:    return Math.min(90, totalMins);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=55, stale-while-revalidate=10');

  const afKey = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  const fdKey = process.env.FOOTBALL_DATA_KEY;

  if (!afKey && !fdKey) {
    log('ERROR: no API keys configured');
    return res.status(200).json({ response: [], error: 'No API keys configured' });
  }

  // Return cached response if still fresh
  const now = Date.now();
  if (_cache.data && now - _cache.ts < CACHE_TTL) {
    log(`cache hit (${Math.round((now - _cache.ts) / 1000)}s old)`);
    return res.status(200).json(_cache.data);
  }

  // Fetch both APIs simultaneously
  const [afRes, fdRes] = await Promise.allSettled([
    afKey
      ? fetch('https://v3.football.api-sports.io/fixtures?live=all', {
          headers: { 'x-apisports-key': afKey }
        }).then(r => r.json()).catch(e => ({ _err: e.message }))
      : Promise.resolve(null),
    fdKey
      ? fetch('https://api.football-data.org/v4/matches?status=LIVE', {
          headers: { 'X-Auth-Token': fdKey }
        }).then(r => r.json()).catch(e => ({ _err: e.message }))
      : Promise.resolve(null)
  ]);

  const combined = [];
  const seen = new Set();

  // --- API-Football (primary: wider league coverage) ---
  try {
    const data = afRes.status === 'fulfilled' ? afRes.value : null;
    if (data?.errors && Object.keys(data.errors).length > 0) {
      log(`af API errors: ${JSON.stringify(data.errors)}`);
    }
    if (data?.paging) {
      log(`af paging: current=${data.paging.current} total=${data.paging.total}`);
    }
    if (data && !data._err && !data.errors?.token) {
      const raw = Array.isArray(data.response) ? data.response : [];
      log(`af raw: ${raw.length} (plan remaining: ${data.results ?? '?'})`);

      for (const m of raw) {
        const sh = m.fixture?.status?.short || '';

        // Must be a recognised live status — trust the API on status
        if (!LIVE_STATUS.has(sh)) continue;

        // Elapsed: free tier often returns null — estimate from kickoff time as fallback
        let elapsed = m.fixture?.status?.elapsed;
        if (!elapsed && elapsed !== 0) {
          // elapsed is null/undefined — estimate from fixture date
          elapsed = estimateElapsed(m.fixture?.date, sh);
        }
        elapsed = elapsed || 0;

        const stats = m.statistics || [];
        const hSOT  = getStat(stats, 0, 'Shots on Goal');
        const aSOT  = getStat(stats, 1, 'Shots on Goal');
        const hSoff = getStat(stats, 0, 'Shots off Goal');
        const aSoff = getStat(stats, 1, 'Shots off Goal');
        const hDA   = getStat(stats, 0, 'Dangerous Attacks');
        const aDA   = getStat(stats, 1, 'Dangerous Attacks');
        const hC    = getStat(stats, 0, 'Corner Kicks');
        const aC    = getStat(stats, 1, 'Corner Kicks');

        // Stale-data guard: only applied when stats ARE present;
        // if a match has stats but ALL activity = 0 after min 10 → ghost/stale
        if (stats.length > 0 && elapsed > 10) {
          const activity = hSOT + aSOT + hSoff + aSoff + hDA + aDA + hC + aC;
          if (activity === 0) {
            log(`stale filtered: ${m.teams?.home?.name} vs ${m.teams?.away?.name} min=${elapsed}`);
            continue;
          }
        }

        const hxg = getStat(stats, 0, 'expected_goals');
        const axg = getStat(stats, 1, 'expected_goals');
        const key  = norm(m.teams?.home?.name) + '|' + norm(m.teams?.away?.name);

        if (seen.has(key)) continue;
        seen.add(key);

        combined.push({
          _src: 'af',
          _validated: true,
          fixture: {
            id:     m.fixture.id,
            date:   m.fixture.date,
            status: { short: sh, long: m.fixture.status.long, elapsed }
          },
          league: {
            id:      m.league.id,
            name:    m.league.name,
            country: m.league.country,
            logo:    m.league.logo,
            flag:    m.league.flag,
            f:       COUNTRY_FLAG[m.league.country] || '🌐'
          },
          teams: {
            home: { id: m.teams.home.id, name: m.teams.home.name, logo: m.teams.home.logo },
            away: { id: m.teams.away.id, name: m.teams.away.name, logo: m.teams.away.logo }
          },
          goals:      { home: m.goals.home ?? 0, away: m.goals.away ?? 0 },
          xg:         { home: hxg, away: axg },
          statistics: stats,
          events:     m.events  || [],
          lineups:    m.lineups || []
        });
      }
    }
  } catch (e) {
    log(`af parse error: ${e.message}`);
  }

  // --- football-data.org (supplementary: real-time top European leagues) ---
  const FD_LIVE  = new Set(['IN_PLAY', 'PAUSED', 'EXTRA_TIME', 'PENALTY_SHOOTOUT']);
  const FD_SHORT = { IN_PLAY: '1H', PAUSED: 'HT', EXTRA_TIME: 'ET', PENALTY_SHOOTOUT: 'P' };

  try {
    const data = fdRes.status === 'fulfilled' ? fdRes.value : null;
    if (data && !data._err && !data.errorCode && Array.isArray(data.matches)) {
      log(`fd raw: ${data.matches.length}`);
      for (const m of data.matches) {
        if (!FD_LIVE.has(m.status)) continue;
        const key = norm(m.homeTeam?.shortName || m.homeTeam?.name) + '|' +
                    norm(m.awayTeam?.shortName || m.awayTeam?.name);
        if (seen.has(key)) continue; // already covered by af
        seen.add(key);

        combined.push({
          _src: 'fd',
          _validated: true,
          fixture: {
            id:     m.id,
            date:   m.utcDate,
            status: { short: FD_SHORT[m.status] || m.status, long: m.status, elapsed: m.minute || 0 }
          },
          league: {
            id:      m.competition.id,
            name:    m.competition.name,
            country: m.area?.name || '',
            logo:    m.competition.emblem || '',
            flag:    '',
            f:       COUNTRY_FLAG[m.area?.name] || '🌐'
          },
          teams: {
            home: { id: m.homeTeam.id, name: m.homeTeam.shortName || m.homeTeam.name, logo: m.homeTeam.crest || '' },
            away: { id: m.awayTeam.id, name: m.awayTeam.shortName || m.awayTeam.name, logo: m.awayTeam.crest || '' }
          },
          goals: {
            home: m.score.fullTime.home ?? m.score.halfTime.home ?? 0,
            away: m.score.fullTime.away ?? m.score.halfTime.away ?? 0
          },
          xg: { home: 0, away: 0 },
          statistics: [], events: [], lineups: []
        });
      }
    }
  } catch (e) {
    log(`fd parse error: ${e.message}`);
  }

  // Enrich uncached matches (max 5 per call to preserve API quota)
  if (afKey) {
    const toEnrich = combined
      .filter(m => m.teams?.home?.id && m.teams?.away?.id && !enrichCache.has(m.fixture.id))
      .slice(0, 5);
    if (toEnrich.length > 0) {
      log(`enriching ${toEnrich.length} new matches`);
      await Promise.all(toEnrich.map(m =>
        enrichMatch(m.fixture.id, m.teams.home.id, m.teams.away.id, afKey)
      ));
    }
  }
  for (const m of combined) {
    m.enrichData = enrichCache.get(m.fixture.id) || null;
  }

  log(`final combined: ${combined.length}`);
  const result = { response: combined };
  _cache = { data: result, ts: now };
  return res.status(200).json(result);
}
