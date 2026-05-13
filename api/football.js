import { ALLOWED_LEAGUE_IDS } from './leagues.js';

function log(msg) {
  console.log(`[football] ${new Date().toISOString()} ${msg}`);
}

const STALE_MS = 5 * 60 * 1000; // 5 min — max age for a "live" match to stay visible

async function fetchH2H(homeId, awayId, key) {
  try {
    const [d1, d2, d3] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/fixtures?team=${homeId}&last=10&status=FT`, { headers: { 'x-apisports-key': key } }).then(r => r.json()),
      fetch(`https://v3.football.api-sports.io/fixtures?team=${awayId}&last=10&status=FT`, { headers: { 'x-apisports-key': key } }).then(r => r.json()),
      fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`, { headers: { 'x-apisports-key': key } }).then(r => r.json()),
    ]);
    const hGames = (d1.response || []).filter(m => m.teams?.home?.id === homeId).slice(0, 10);
    const aGames = (d2.response || []).filter(m => m.teams?.away?.id === awayId).slice(0, 10);
    const h2hGames = (d3.response || []).slice(0, 10);

    const avg = (arr, fn) => arr.length ? arr.reduce((s, m) => s + fn(m), 0) / arr.length : null;
    const pct    = (arr, fn) => arr.length ? Math.round(arr.filter(fn).length / arr.length * 100) : null;
    const goals  = m => (m.goals?.home ?? 0) + (m.goals?.away ?? 0);

    return {
      homeAvgScored:    avg(hGames, m => m.goals?.home ?? 0),
      homeAvgConceded:  avg(hGames, m => m.goals?.away ?? 0),
      awayAvgScored:    avg(aGames, m => m.goals?.away ?? 0),
      awayAvgConceded:  avg(aGames, m => m.goals?.home ?? 0),
      h2hOver15:        pct(h2hGames, m => goals(m) > 1),
      h2hAvgGoals:      avg(h2hGames, goals),
    };
  } catch { return {}; }
}

const enrichCache = new Map();

async function enrichOne(m, key, sbUrl, sbKey) {
  const hId = m.teams?.home?.id;
  const aId = m.teams?.away?.id;
  if (!hId || !aId) return m;
  const cacheKey = `${hId}-${aId}`;
  if (enrichCache.has(cacheKey)) return { ...m, ...enrichCache.get(cacheKey) };

  const stats = m.statistics || [];
  const liveStats = {
    xg: 0, sot: 0, da: 0, corners: 0,
    possession_home: 0, possession_away: 0,
  };
  for (const team of stats) {
    for (const st of (team.statistics || [])) {
      const v = parseFloat(st.value) || 0;
      if (st.type === 'expected_goals')      liveStats.xg         += v;
      if (st.type === 'Shots on Goal')        liveStats.sot        += v;
      if (st.type === 'Dangerous Attacks')    liveStats.da         += v;
      if (st.type === 'Corner Kicks')         liveStats.corners    += v;
      if (st.type === 'Ball Possession') {
        if (team.team?.id === hId) liveStats.possession_home = v;
        else                       liveStats.possession_away = v;
      }
    }
  }

  const h2h = await fetchH2H(hId, aId, key);
  const enriched = { ...h2h, liveStats };
  enrichCache.set(cacheKey, enriched);
  return { ...m, ...enriched };
}

const fdCompMap = {
  2021: { id: 39,  name: 'Premier League',    country: 'England' },
  2014: { id: 140, name: 'La Liga',            country: 'Spain' },
  2002: { id: 78,  name: 'Bundesliga',         country: 'Germany' },
  2019: { id: 135, name: 'Serie A',            country: 'Italy' },
  2015: { id: 61,  name: 'Ligue 1',            country: 'France' },
  2003: { id: 88,  name: 'Eredivisie',         country: 'Netherlands' },
  2017: { id: 94,  name: 'Primeira Liga',      country: 'Portugal' },
  2016: { id: 207, name: 'Super League',       country: 'Switzerland' },
  2018: { id: 144, name: 'Pro League',         country: 'Belgium' },
  2001: { id: 2,   name: 'Champions League',   country: 'Europe' },
  2137: { id: 3,   name: 'Europa League',      country: 'Europe' },
  2146: { id: 848, name: 'Conference League',  country: 'Europe' },
};

function mapFdMatch(m) {
  const comp    = fdCompMap[m.competition?.id] || { id: 0, name: m.competition?.name || '', country: '' };
  const elapsed = m.minute ?? (m.status?.elapsed ?? null);
  return {
    _src: 'fd',
    fixture: {
      id:      m.id,
      date:    m.utcDate,
      status:  {
        short:   m.status?.short ?? m.status,
        elapsed: elapsed,
      },
    },
    league:  { id: comp.id, name: comp.name, country: comp.country, flag: null },
    teams:   {
      home: { id: m.homeTeam?.id, name: m.homeTeam?.name ?? m.homeTeam?.shortName ?? '' },
      away: { id: m.awayTeam?.id, name: m.awayTeam?.name ?? m.awayTeam?.shortName ?? '' },
    },
    goals:   { home: m.score?.fullTime?.home ?? m.score?.fullTime?.homeTeam ?? null,
               away: m.score?.fullTime?.away ?? m.score?.fullTime?.awayTeam ?? null },
    statistics: [],
    events:     [],
    players:    [],
  };
}

const LIVE_STATUSES = new Set(['1H','HT','2H','ET','BT','P','SUSP','INT','LIVE']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key    = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  const fdKey  = process.env.FOOTBALL_DATA_KEY;
  const sbUrl  = process.env.SUPABASE_URL;
  const sbKey  = process.env.SUPABASE_KEY;

  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  res.setHeader('Cache-Control', 'no-store');

  // ── API-Football live ──────────────────────────────────────────
  let afMatches = [];
  try {
    const r = await fetch('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: { 'x-apisports-key': key },
    });
    const d = await r.json();
    const raw = d.response || [];
    log(`af raw live: ${raw.length}`);

    const now = Date.now();

    // Status filter — keep only genuinely live statuses
    const passedStatus = raw.filter(m => LIVE_STATUSES.has(m.fixture?.status?.short));
    log(`af status-filter: ${passedStatus.length}/${raw.length} live; stale-guard kept: ${passedStatus.length}/${passedStatus.length}`);

    afMatches = passedStatus.map(m => ({ ...m, _src: 'af' }));
  } catch (e) {
    log(`af error: ${e.message}`);
  }

  // ── football-data.org live ─────────────────────────────────────
  let fdMatches = [];
  if (fdKey) {
    try {
      const r = await fetch('https://api.football-data.org/v4/matches?status=IN_PLAY,PAUSED,HALFTIME', {
        headers: { 'X-Auth-Token': fdKey },
      });
      const d = await r.json();
      const raw = (d.matches || []).filter(m => fdCompMap[m.competition?.id]);
      fdMatches = raw.map(m => mapFdMatch(m));
      log(`fd raw: ${(d.matches||[]).length} → after comp-filter: ${fdMatches.length}`);
    } catch (e) {
      log(`fd error: ${e.message}`);
    }
  }

  // ── Merge: af primary, fd fills gaps ──────────────────────────
  const afFixtureIds = new Set(afMatches.map(m => m.fixture?.id));
  const afTeamPairs  = new Set(afMatches.map(m => `${m.teams?.home?.id}-${m.teams?.away?.id}`));

  const fdNew = fdMatches.filter(m => {
    const pair = `${m.teams?.home?.id}-${m.teams?.away?.id}`;
    return !afFixtureIds.has(m.fixture?.id) && !afTeamPairs.has(pair);
  });
  log(`fd contributing ${fdNew.length} new matches (not in af)`);

  const combined = [...afMatches, ...fdNew];
  log(`combined before league-filter: ${combined.length}`);

  // Strict whitelist: af-source uses API-Football IDs; fd-source uses football-data.org
  // competition IDs (different numbering) — for fd we only apply the women's filter.
  const WOMEN_RE = /women|feminin|femenin|ladies|female|w league|nwsl|wsl/i;
  const LOWER_DIV_RE = /\b[3-9]\.\s*(liga|division|div)\b/i;
  const filtered = combined.filter(m => {
    if (WOMEN_RE.test(m.league?.name || '')) return false;
    if (LOWER_DIV_RE.test(m.league?.name || '')) return false;
    if (m._src === 'fd') return true; // fd IDs differ — league already curated by fd.org
    return ALLOWED_LEAGUE_IDS.has(m.league?.id);
  });

  // Log which af-source leagues were blocked so we can fix the whitelist
  const blocked = combined.filter(m =>
    m._src === 'af' && !ALLOWED_LEAGUE_IDS.has(m.league?.id) && !WOMEN_RE.test(m.league?.name || '')
  );
  if (blocked.length) {
    const ids = [...new Map(blocked.map(m => [m.league.id, `${m.league.id}:"${m.league.name}" (${m.league.country})`])).values()];
    log(`af leagues BLOCKED by whitelist (${blocked.length} matches): ${ids.join(' | ')}`);
  }
  log(`league filter: ${combined.length} → ${filtered.length} (removed ${combined.length - filtered.length})`);

  log(`final combined: ${filtered.length}`);
  const result = { response: filtered };

  // ── Optional enrichment ────────────────────────────────────────
  const toEnrich = filtered
    .filter(m => m._src !== 'fd' && m.teams?.home?.id && m.teams?.away?.id && !enrichCache.has(m.fixture.id))
    .slice(0, 5);

  if (toEnrich.length && key) {
    await Promise.allSettled(toEnrich.map(m => enrichOne(m, key, sbUrl, sbKey)));
  }

  return res.status(200).json(result);
}
