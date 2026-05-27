import { ALLOWED_LEAGUE_IDS } from './leagues.js';
import { isAllowedMatch } from './utils/league-filter.js';
import { calcNextGoal } from './utils/live-score.js';
import { calibrateNgp } from './utils/ngp-calibration.js';
import { query } from './db.js';
import { fetchApiFootball } from './utils/fetch-api.js';

function log(msg) {
  console.log(`[football] ${new Date().toISOString()} ${msg}`);
}

async function fetchH2H(homeId, awayId) {
  try {
    const [d1, d2, d3] = await Promise.all([
      fetchApiFootball(`/fixtures?team=${homeId}&last=10&status=FT`).then(r => r.json()),
      fetchApiFootball(`/fixtures?team=${awayId}&last=10&status=FT`).then(r => r.json()),
      fetchApiFootball(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`).then(r => r.json()),
    ]);
    const hGames = (d1.response || []).filter(m => m.teams?.home?.id === homeId).slice(0, 10);
    const aGames = (d2.response || []).filter(m => m.teams?.away?.id === awayId).slice(0, 10);
    const h2hGames = (d3.response || []).slice(0, 10);

    const avg = (arr, fn) => arr.length ? arr.reduce((s, m) => s + fn(m), 0) / arr.length : null;
    const pct    = (arr, fn) => arr.length >= 5 ? Math.round(arr.filter(fn).length / arr.length * 100) : null;
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

  const h2h = await fetchH2H(hId, aId);
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
    const r = await fetchApiFootball('/fixtures?live=all');
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

  // ── Filters — sistem centralizat din utils/league-filter.js ────
  const filtered = passedStatus.filter(m => isAllowedMatch(m, ALLOWED_LEAGUE_IDS));
  log(`[Filter] ${passedStatus.length} meciuri → ${filtered.length} după filtrare`);

  // ── Injectie _ng per meci ────────────────────────────────────
  // Sursa primara: match_snapshots.ng (calibrat + smoothed de scanner.js).
  // Fallback: calc local din SOT/xG cand snapshot lipseste (meci nou).
  const fixIds = filtered.map(m => m.fixture?.id).filter(Boolean);
  let snapMap = {};
  if (fixIds.length > 0) {
    try {
      const { rows } = await query(
        `SELECT fixture_id, ng, ng_15min FROM match_snapshots WHERE fixture_id = ANY($1)`,
        [fixIds]
      );
      for (const r of rows) snapMap[r.fixture_id] = { ng: r.ng, ng15: r.ng_15min };
    } catch (e) {
      log(`match_snapshots read err: ${e.message}`);
    }
  }

  for (const m of filtered) {
    const fid = m.fixture?.id;
    // Prefer NGP din DB (scanner.js = singura sursa autoritara)
    if (fid && snapMap[fid] && typeof snapMap[fid].ng === 'number') {
      m._ng = snapMap[fid].ng;
      if (typeof snapMap[fid].ng15 === 'number') m._ng15 = snapMap[fid].ng15;
      continue;
    }
    // Fallback: calc local cand snapshot lipseste (rar, doar la meciuri noi)
    const mn    = m.fixture?.status?.elapsed || 0;
    const stats = Array.isArray(m.statistics) ? m.statistics : [];
    const hStat = stats[0]?.statistics || [];
    const aStat = stats[1]?.statistics || [];
    const findVal = (arr, type) => parseFloat(arr.find(s => s.type === type)?.value) || 0;
    const hxg  = findVal(hStat, 'expected_goals');
    const axg  = findVal(aStat, 'expected_goals');
    const hSOT = findVal(hStat, 'Shots on Goal');
    const aSOT = findVal(aStat, 'Shots on Goal');
    const txg  = hxg + axg;
    const homeFormGoals = (mn > 0 && hSOT > 0) ? (hSOT / mn) * 9 : 0.35;
    const awayFormGoals = (mn > 0 && aSOT > 0) ? (aSOT / mn) * 9 : 0.35;
    const ngRaw = calcNextGoal({ mn, txg, homeFormGoals, awayFormGoals });
    m._ng = mn < 10 ? 0 : calibrateNgp(ngRaw);
  }

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
