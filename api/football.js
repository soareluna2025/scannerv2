import { ALLOWED_LEAGUE_IDS } from './leagues.js';

function log(msg) {
  console.log(`[football] ${new Date().toISOString()} ${msg}`);
}

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
const ENRICH_TTL = 5 * 60 * 1000; // 5 minutes

async function enrichOne(m, key) {
  const hId = m.teams?.home?.id;
  const aId = m.teams?.away?.id;
  if (!hId || !aId) return m;
  const cacheKey = `${hId}_${aId}`;
  const cached = enrichCache.get(cacheKey);
  if (cached) {
    if (Date.now() - cached.ts < ENRICH_TTL) return { ...m, ...cached.data };
    enrichCache.delete(cacheKey);
  }

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

  if (enrichCache.size > 200) {
    [...enrichCache.keys()].slice(0, 100).forEach(k => enrichCache.delete(k));
  }

  const h2h = await fetchH2H(hId, aId, key);
  const enriched = { ...h2h, liveStats };
  enrichCache.set(cacheKey, { data: enriched, ts: Date.now() });
  return { ...m, ...enriched };
}

const LIVE_STATUSES = new Set(['1H','HT','2H','ET','BT','P','SUSP','INT','LIVE']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;

  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  res.setHeader('Cache-Control', 'no-store');

  // ── Sursă unică: API-Football live ────────────────────────────
  // football-data.org a fost eliminat — ocola ALLOWED_LEAGUE_IDS complet
  let raw = [];
  try {
    const r = await fetch('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: { 'x-apisports-key': key },
    });
    const d = await r.json();
    raw = d.response || [];
    log(`af raw live: ${raw.length}`);

    if (d.errors && Object.keys(d.errors).length > 0) {
      log(`af errors: ${JSON.stringify(d.errors)}`);
      return res.status(200).json({ response: [], _debug: { error: JSON.stringify(d.errors) } });
    }
  } catch (e) {
    log(`af error: ${e.message}`);
    return res.status(200).json({ response: [], _debug: { error: e.message } });
  }

  // Status filter — only genuinely live statuses
  const passedStatus = raw.filter(m => LIVE_STATUSES.has(m.fixture?.status?.short));
  log(`af status-filter: ${passedStatus.length}/${raw.length}`);

  // ── Filters ────────────────────────────────────────────────────
  const WOMEN_RE = /women|feminin|femenin|ladies|female|w league|nwsl|wsl|vrouwen|dames|frauen|damen|femmes|femminile|feminino|\bW\b/i;
  const LOWER_DIV_RE = /\b[3-9]\.\s*(liga|division|div)\b|\bUSL League Two\b|\bLeague Two\b|\bOberliga\b|\bLandesliga\b|\bKreisliga\b|\bBezirksliga\b|\bVerbandsliga\b|\bVorbandsliga\b/i;
  const YOUTH_RE = /\bU-?1[6-9]\b|\bU-?2[0-3]\b|\bUnder.?1[6-9]\b|\bUnder.?2[0-3]\b/i;

  let cntWomen = 0, cntLowerDiv = 0, cntYouth = 0, cntWhitelist = 0;

  const filtered = passedStatus.filter(m => {
    const ln = m.league?.name || '';
    const hn = m.teams?.home?.name || '';
    const an = m.teams?.away?.name || '';
    if (WOMEN_RE.test(ln))                                            { cntWomen++;    return false; }
    if (LOWER_DIV_RE.test(ln))                                        { cntLowerDiv++; return false; }
    if (YOUTH_RE.test(ln) || YOUTH_RE.test(hn) || YOUTH_RE.test(an)) { cntYouth++;    return false; }
    if (!ALLOWED_LEAGUE_IDS.has(Number(m.league?.id)))                { cntWhitelist++; return false; }
    return true;
  });

  log(`filters: women=${cntWomen} lowerDiv=${cntLowerDiv} youth=${cntYouth} whitelist=${cntWhitelist} → kept=${filtered.length}/${passedStatus.length}`);

  if (cntWhitelist > 0) {
    const blockedLeagues = passedStatus.filter(m =>
      !WOMEN_RE.test(m.league?.name || '') &&
      !LOWER_DIV_RE.test(m.league?.name || '') &&
      !ALLOWED_LEAGUE_IDS.has(Number(m.league?.id))
    );
    const ids = [...new Map(blockedLeagues.map(m => [
      m.league?.id,
      `${m.league?.id}:"${m.league?.name}" (${m.league?.country})`,
    ])).values()];
    if (ids.length) log(`whitelist BLOCKED: ${ids.join(' | ')}`);
  }

  log(`final: ${filtered.length}`);

  // ── Optional enrichment ────────────────────────────────────────
  const toEnrich = filtered
    .filter(m => {
      if (!m.teams?.home?.id || !m.teams?.away?.id) return false;
      const ck = `${m.teams.home.id}_${m.teams.away.id}`;
      const c = enrichCache.get(ck);
      return !c || Date.now() - c.ts >= ENRICH_TTL;
    })
    .slice(0, 5);

  if (toEnrich.length) {
    await Promise.allSettled(toEnrich.map(m => enrichOne(m, key)));
  }

  return res.status(200).json({ response: filtered });
}
