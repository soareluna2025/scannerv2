import { ALLOWED_LEAGUE_IDS } from './leagues.js';

function log(msg) {
  console.log(`[today] ${new Date().toISOString()} ${msg}`);
}

const WOMEN_RE    = /women|feminin|femenin|ladies|female|w league|nwsl|wsl/i;
const LOWER_DIV_RE = /\b[3-9]\.\s*(liga|division|div)\b/i;

function dateStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

async function getFixturesFromSupabase(sbUrl, sbKey) {
  try {
    const now  = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const res = await fetch(
      `${sbUrl}/rest/v1/fixtures` +
      `?kickoff_time=gte.${now.toISOString()}` +
      `&kickoff_time=lte.${in24h.toISOString()}` +
      `&status_short=eq.NS` +
      `&order=kickoff_time.asc`,
      { headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` } }
    );
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (_) { return []; }
}

async function getLeaguesFromSupabase(leagueIds, sbUrl, sbKey) {
  try {
    if (!leagueIds.length) return [];
    const res = await fetch(
      `${sbUrl}/rest/v1/leagues?id=in.(${leagueIds.join(',')})&select=id,name,country,logo`,
      { headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` } }
    );
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (_) { return []; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=30');

  const key   = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_KEY;

  // --- Snapshots action: returns top pre_match_snapshots by composite_score ---
  const action = (req.query && req.query.action) ||
    new URL(req.url || '', 'http://localhost').searchParams.get('action');
  if (action === 'snapshots') {
    if (!sbUrl || !sbKey) {
      return res.status(200).json({ snapshots: [], error: 'Supabase not configured' });
    }
    try {
      const r = await fetch(
        `${sbUrl}/rest/v1/pre_match_snapshots` +
        `?outcome=eq.PENDING` +
        `&order=composite_score.desc` +
        `&limit=10` +
        `&select=*`,
        { headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` } }
      );
      const data = await r.json();
      const snapshots = Array.isArray(data) ? data : [];
      log(`snapshots: ${snapshots.length}`);
      return res.status(200).json({ snapshots });
    } catch (e) {
      log(`snapshots error: ${e.message}`);
      return res.status(200).json({ snapshots: [], error: e.message });
    }
  }

  if (!key) {
    log('ERROR: no API-Football key configured');
    return res.status(200).json({ response: [], error: 'API key not configured' });
  }

  try {
    // --- Try Supabase first ---
    const sbFixtures = sbUrl && sbKey ? await getFixturesFromSupabase(sbUrl, sbKey) : [];
    log(`supabase fixtures: ${sbFixtures.length}`);

    if (sbFixtures.length >= 5) {
      // Apply league whitelist filter
      const afterLeague = sbFixtures.filter(f => ALLOWED_LEAGUE_IDS.has(f.league_id));
      log(`after league filter (supabase): ${afterLeague.length}`);

      // Fetch league names for the filtered fixtures in one batch
      const leagueIds = [...new Set(afterLeague.map(f => f.league_id))];
      const leagueRows = await getLeaguesFromSupabase(leagueIds, sbUrl, sbKey);
      const leagueMap  = Object.fromEntries((leagueRows || []).map(l => [l.id, l]));

      // Transform to API-Football-like format with league names
      const raw = afterLeague.map(f => {
        const lg = leagueMap[f.league_id] || {};
        return {
          fixture: { id: f.id, date: f.kickoff_time, status: { short: f.status_short, long: f.status_long } },
          league:  { id: f.league_id, name: lg.name || '', country: lg.country || '', flag: lg.logo || '' },
          teams:   { home: { id: f.home_team_id, name: f.home_team_name },
                     away: { id: f.away_team_id, name: f.away_team_name } },
          goals:   { home: null, away: null },
        };
      });

      // Apply name-based filters now that we have league names
      const afterWomen = raw.filter(m => !WOMEN_RE.test(m.league?.name || ''));
      const afterDiv   = afterWomen.filter(m => !LOWER_DIV_RE.test(m.league?.name || ''));

      log(`final (supabase): ${afterDiv.length}`);

      return res.status(200).json({
        response: afterDiv.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date)),
        _debug: {
          source:        'supabase',
          rawTotal:      sbFixtures.length,
          afterLeague:   afterLeague.length,
          afterWomen:    afterWomen.length,
          afterLowerDiv: afterDiv.length,
          final:         afterDiv.length,
        },
      });
    }

    // --- Fallback: API-Football ---
    log('supabase insufficient, falling back to API-Football');
    const [d0, d1] = [dateStr(0), dateStr(1)];
    log(`fetching 2 days: ${d0} / ${d1}`);

    const hdr  = { 'x-apisports-key': key };
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

    const now    = Date.now();
    const cutoff = now + 24 * 60 * 60 * 1000;
    const seen   = new Set();
    const raw    = [
      ...(j0.response || []),
      ...(j1.response || []),
    ].filter(m => {
      if (!m.fixture?.id || seen.has(m.fixture.id)) return false;
      seen.add(m.fixture.id);
      const kickoff = new Date(m.fixture.date).getTime();
      return kickoff >= now && kickoff <= cutoff;
    });
    log(`raw total (deduped, 24h window): ${raw.length}`);

    const afterLeague = raw.filter(m => ALLOWED_LEAGUE_IDS.has(m.league?.id));
    log(`after league filter: ${afterLeague.length} (removed ${raw.length - afterLeague.length})`);

    const afterWomen = afterLeague.filter(m => !WOMEN_RE.test(m.league?.name || ''));
    log(`after women filter: ${afterWomen.length} (removed ${afterLeague.length - afterWomen.length})`);

    const afterDiv = afterWomen.filter(m => !LOWER_DIV_RE.test(m.league?.name || ''));
    log(`after lower-div filter: ${afterDiv.length} (removed ${afterWomen.length - afterDiv.length})`);

    const result = afterDiv
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
        source:        'api-football',
        days:          [d0, d1],
        window:        '24h',
        rawPerDay:     counts,
        rawTotal:      raw.length,
        afterLeague:   afterLeague.length,
        afterWomen:    afterWomen.length,
        afterLowerDiv: afterDiv.length,
        final:         result.length,
      },
    });

  } catch (e) {
    log(`ERROR: ${e.message}`);
    return res.status(200).json({ response: [], error: e.message });
  }
}
