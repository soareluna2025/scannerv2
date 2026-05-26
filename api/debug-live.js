// GET /api/debug-live — diagnostic: ce returneaza API-Football live=all si ce filtram
// Folosit DOAR pentru debugging. Nu afecteaza functionalitatea.

import { ALLOWED_LEAGUE_IDS } from './leagues.js';
import { isAllowedMatch } from './utils/league-filter.js';

const LIVE_STATUSES = new Set(['1H','HT','2H','ET','BT','P','SUSP','INT','LIVE']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  let raw = [];
  let apiError = null;
  try {
    const r = await fetch('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: { 'x-apisports-key': key },
    });
    const d = await r.json();
    if (d.errors && Object.keys(d.errors).length > 0) {
      apiError = d.errors;
    }
    raw = d.response || [];
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // Grupare pe ligie
  const byLeague = {};
  for (const m of raw) {
    const lid   = m.league?.id;
    const lname = m.league?.name || '?';
    const sh    = m.fixture?.status?.short || '?';
    const key2  = `${lid}|${lname}`;
    if (!byLeague[key2]) {
      byLeague[key2] = {
        id: lid, name: lname, matches: [], passedStatus: 0, passedFilter: 0,
        blockedReason: null,
      };
    }
    byLeague[key2].matches.push({
      fid:    m.fixture?.id,
      status: sh,
      home:   m.teams?.home?.name,
      away:   m.teams?.away?.name,
      min:    m.fixture?.status?.elapsed,
    });
    if (LIVE_STATUSES.has(sh)) {
      byLeague[key2].passedStatus++;
      if (isAllowedMatch(m, ALLOWED_LEAGUE_IDS)) {
        byLeague[key2].passedFilter++;
      } else {
        // Determina motivul blocarii
        if (!ALLOWED_LEAGUE_IDS.has(Number(lid))) {
          byLeague[key2].blockedReason = `ID ${lid} nu e in ALLOWED_LEAGUE_IDS`;
        } else {
          byLeague[key2].blockedReason = 'filtrat de isAllowedMatch (termen feminin/tineret/ligie inferioara?)';
        }
      }
    }
  }

  const sorted = Object.values(byLeague).sort((a, b) => b.matches.length - a.matches.length);
  const allowed  = sorted.filter(l => l.passedFilter > 0);
  const blocked  = sorted.filter(l => l.passedFilter === 0 && l.passedStatus > 0);
  const noStatus = sorted.filter(l => l.passedStatus === 0);

  return res.status(200).json({
    ok: true,
    api_error: apiError,
    total_raw: raw.length,
    total_leagues: sorted.length,
    allowed_count: allowed.length,
    blocked_count: blocked.length,
    allowed,
    blocked,
    no_live_status: noStatus,
    copa_sudamericana: sorted.find(l => l.id === 11) || null,
    copa_libertadores: sorted.find(l => l.id === 13) || null,
  });
}
