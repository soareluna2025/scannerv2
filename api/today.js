import { ALLOWED_LEAGUE_IDS } from './leagues.js';
import { query } from './db.js';
import { isAllowedMatch } from './utils/league-filter.js';

function log(msg) {
  console.log(`[today] ${new Date().toISOString()} ${msg}`);
}

function dateStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

async function getFixturesFromDB() {
  try {
    const now  = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const allowedIds = [...ALLOWED_LEAGUE_IDS];
    const r = await query(
      `SELECT f.fixture_id AS id, f.match_date AS kickoff_time, f.status_short, f.status_long,
              f.league_id, f.home_team_id, f.away_team_id,
              COALESCE(th.name, f.home_team_name) AS home_team_name, th.logo AS home_logo,
              COALESCE(ta.name, f.away_team_name) AS away_team_name, ta.logo AS away_logo
       FROM fixtures f
       LEFT JOIN teams th ON th.team_id = f.home_team_id
       LEFT JOIN teams ta ON ta.team_id = f.away_team_id
       WHERE f.status_short = 'NS'
         AND f.match_date >= $1 AND f.match_date <= $2
         AND f.league_id = ANY($3)
       ORDER BY f.match_date ASC`,
      [now.toISOString(), in24h.toISOString(), allowedIds]
    );
    return r.rows;
  } catch (_) { return []; }
}

async function getLeaguesFromDB(leagueIds) {
  try {
    if (!leagueIds.length) return [];
    const r = await query(
      'SELECT league_id AS id, name, country, logo FROM leagues WHERE league_id = ANY($1)',
      [leagueIds]
    );
    return r.rows;
  } catch (_) { return []; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=30');

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;

  // --- Snapshots action ---
  const action = (req.query && req.query.action) ||
    new URL(req.url || '', 'http://localhost').searchParams.get('action');
  if (action === 'snapshots') {
    try {
      const { rows } = await query(`
        SELECT
          p.fixture_id,
          ROUND(p.over15_prob * 0.40 + p.gg_prob * 0.30 + COALESCE(p.confidence, 50) * 0.30, 1)
            AS composite_score,
          p.over15_prob  AS over15_score,
          p.gg_prob      AS gg_score,
          p.confidence,
          p.home_team,
          p.away_team,
          p.match_date   AS kickoff_time,
          p.league_id,
          p.league_name
        FROM predictions p
        WHERE p.match_date > NOW()
          AND p.match_date < NOW() + INTERVAL '3 days'
          AND p.result_over15 IS NULL
        ORDER BY (p.over15_prob * 0.40 + p.gg_prob * 0.30 + COALESCE(p.confidence, 50) * 0.30) DESC NULLS LAST
        LIMIT 20
      `).catch(() => ({ rows: [] }));
      return res.status(200).json({ snapshots: rows });
    } catch (e) {
      return res.status(200).json({ snapshots: [], error: e.message });
    }
  }

  if (!key) {
    log('ERROR: no API-Football key configured');
    return res.status(200).json({ response: [], error: 'API key not configured' });
  }

  try {
    // --- Try PostgreSQL first ---
    const dbFixtures = await getFixturesFromDB();
    log(`db fixtures: ${dbFixtures.length}`);

    if (dbFixtures.length >= 5) {
      // Use Number() to guard against pg returning league_id as string
      const afterLeague = dbFixtures.filter(f => ALLOWED_LEAGUE_IDS.has(Number(f.league_id)));
      log(`after league filter (db): ${afterLeague.length}/${dbFixtures.length} (removed ${dbFixtures.length - afterLeague.length})`);

      const leagueIds = [...new Set(afterLeague.map(f => f.league_id))];
      const leagueRows = await getLeaguesFromDB(leagueIds);
      const leagueMap  = Object.fromEntries((leagueRows || []).map(l => [l.id, l]));

      const raw = afterLeague.map(f => {
        const lg = leagueMap[f.league_id] || {};
        return {
          fixture: { id: f.id, date: f.kickoff_time, status: { short: f.status_short, long: f.status_long } },
          league:  { id: f.league_id, name: lg.name || '', country: lg.country || '', flag: lg.logo || '' },
          teams:   { home: { id: f.home_team_id, name: f.home_team_name, logo: f.home_logo || null },
                     away: { id: f.away_team_id, name: f.away_team_name, logo: f.away_logo || null } },
          goals:   { home: null, away: null },
        };
      });

      const allowed = raw.filter(m => isAllowedMatch(m, ALLOWED_LEAGUE_IDS));
      log(`[Filter] ${raw.length} meciuri → ${allowed.length} după filtrare (db)`);

      return res.status(200).json({
        response: allowed.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date)),
        _debug: {
          source:      'postgres',
          rawTotal:    dbFixtures.length,
          afterLeague: afterLeague.length,
          final:       allowed.length,
        },
      });
    }

    // --- Fallback: API-Football ---
    log('db insufficient, falling back to API-Football');
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

    const afterAll = raw.filter(m => isAllowedMatch(m, ALLOWED_LEAGUE_IDS));
    log(`[Filter] ${raw.length} meciuri → ${afterAll.length} după filtrare (api)`);

    const result = afterAll
      .map(m => ({
        fixture: { id: m.fixture.id, date: m.fixture.date, status: m.fixture.status },
        league:  { id: m.league.id, name: m.league.name, country: m.league.country, flag: m.league.flag },
        teams:   { home: { id: m.teams.home.id, name: m.teams.home.name },
                   away: { id: m.teams.away.id, name: m.teams.away.name } },
        goals:   { home: m.goals.home, away: m.goals.away },
      }))
      .sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));

    log(`final: ${result.length} matches`);

    // Salvează meciurile NS în fixtures table (pentru prematch-enrichment + scanner)
    if (result.length > 0) {
      for (const m of result) {
        query(
          `INSERT INTO fixtures
             (fixture_id, league_id, season, home_team_id, home_team_name,
              away_team_id, away_team_name, status_short, status_long, match_date, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
           ON CONFLICT (fixture_id) DO UPDATE SET
             status_short=EXCLUDED.status_short,
             status_long=EXCLUDED.status_long,
             updated_at=NOW()`,
          [
            m.fixture.id,
            m.league.id,
            new Date(m.fixture.date).getFullYear(),
            m.teams.home.id,
            m.teams.home.name,
            m.teams.away.id,
            m.teams.away.name,
            m.fixture.status?.short || 'NS',
            m.fixture.status?.long  || 'Not Started',
            m.fixture.date,
          ]
        ).catch(e => log(`fixtures upsert err ${m.fixture.id}: ${e.message}`));
      }
      log(`fixtures upserted: ${result.length}`);
    }

    return res.status(200).json({
      response: result,
      _debug: {
        source:    'api-football',
        days:      [d0, d1],
        window:    '24h',
        rawPerDay: counts,
        rawTotal:  raw.length,
        final:     result.length,
      },
    });

  } catch (e) {
    log(`ERROR: ${e.message}`);
    return res.status(200).json({ response: [], error: e.message });
  }
}
