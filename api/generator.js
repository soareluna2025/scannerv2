import { query } from './db.js';

const KEY = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
const LIVE_S = new Set(['1H','HT','2H','ET','BT','P','SUSP','INT','LIVE']);

function cleanRef(s) {
  if (!s || s === 'null') return null;
  return s.split(',')[0].trim() || null;
}

function getStat(stats, teamId, type) {
  const ts = (stats || []).find(s => s.team?.id === teamId);
  const st = (ts?.statistics || []).find(s => s.type === type);
  const v = st?.value;
  if (v === null || v === undefined || v === '' || v === 'N/A') return 0;
  return parseFloat(v) || 0;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const mode = (req.query?.mode || 'prematch').toLowerCase();
  if (!KEY) return res.status(500).json({ ok: false, error: 'No API key' });

  try {
    let rawMatches = [];

    if (mode === 'live') {
      const r = await fetch('https://v3.football.api-sports.io/fixtures?live=all', {
        headers: { 'x-apisports-key': KEY },
      });
      const d = await r.json();
      rawMatches = (d.response || []).filter(m => LIVE_S.has(m.fixture?.status?.short));
    } else {
      const now = new Date();
      const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const { rows } = await query(
        `SELECT f.fixture_id, f.league_id, f.home_team_id, f.away_team_id,
                COALESCE(th.name, f.home_team_name) AS home_name,
                COALESCE(ta.name, f.away_team_name) AS away_name,
                f.match_date, l.name AS league_name,
                pd.payload AS pd_fixture
         FROM fixtures f
         LEFT JOIN teams th ON th.team_id = f.home_team_id
         LEFT JOIN teams ta ON ta.team_id = f.away_team_id
         LEFT JOIN leagues l ON l.league_id = f.league_id
         LEFT JOIN LATERAL (
           SELECT payload FROM prematch_data
           WHERE fixture_id = f.fixture_id AND data_type = 'fixture'
           ORDER BY collected_at DESC LIMIT 1
         ) pd ON TRUE
         WHERE f.status_short = 'NS'
           AND f.match_date >= $1 AND f.match_date <= $2
         ORDER BY f.match_date ASC`,
        [now.toISOString(), in24h.toISOString()]
      );
      rawMatches = rows.map(row => {
        let refStr = null;
        const pd = row.pd_fixture;
        if (Array.isArray(pd) && pd[0]?.fixture?.referee) refStr = pd[0].fixture.referee;
        return {
          _db: true,
          fixture: { id: row.fixture_id, date: row.match_date, referee: refStr, status: { short: 'NS', elapsed: 0 } },
          league: { id: row.league_id, name: row.league_name },
          teams: { home: { id: row.home_team_id, name: row.home_name }, away: { id: row.away_team_id, name: row.away_name } },
          goals: { home: null, away: null },
          statistics: [], events: [],
        };
      });
    }

    if (!rawMatches.length) return res.json({ ok: true, mode, matches: [] });

    // Load league_stats
    const leagueIds = [...new Set(rawMatches.map(m => m.league?.id).filter(Boolean))];
    const { rows: lsRows } = await query(
      'SELECT * FROM league_stats WHERE league_id = ANY($1)', [leagueIds]
    ).catch(() => ({ rows: [] }));
    const leagueMap = Object.fromEntries(lsRows.map(r => [Number(r.league_id), r]));

    // Load referee_stats
    const refNames = [...new Set(rawMatches.map(m => cleanRef(m.fixture?.referee)).filter(Boolean))];
    let refMap = {};
    if (refNames.length) {
      const { rows: rsRows } = await query(
        'SELECT * FROM referee_stats WHERE referee_name = ANY($1)', [refNames]
      ).catch(() => ({ rows: [] }));
      refMap = Object.fromEntries(rsRows.map(r => [r.referee_name, r]));
    }

    // Load h2h for all pairs
    const pairs = rawMatches.map(m => ({
      t1: Math.min(m.teams?.home?.id, m.teams?.away?.id),
      t2: Math.max(m.teams?.home?.id, m.teams?.away?.id),
    })).filter(p => p.t1 && p.t2);

    let h2hMap = {};
    if (pairs.length) {
      const t1arr = pairs.map(p => p.t1);
      const t2arr = pairs.map(p => p.t2);
      const { rows: h2hRows } = await query(`
        WITH pairs AS (SELECT unnest($1::int[]) AS t1, unnest($2::int[]) AS t2)
        SELECT h.team1_id, h.team2_id,
          COUNT(*) AS total,
          AVG(h.home_goals + h.away_goals)::NUMERIC(4,2) AS avg_goals,
          (100.0 * COUNT(*) FILTER (WHERE h.home_goals + h.away_goals >= 2) / COUNT(*))::NUMERIC(5,2) AS pct_over_15,
          (100.0 * COUNT(*) FILTER (WHERE h.home_goals + h.away_goals >= 3) / COUNT(*))::NUMERIC(5,2) AS pct_over_25,
          (100.0 * COUNT(*) FILTER (WHERE h.home_goals > 0 AND h.away_goals > 0) / COUNT(*))::NUMERIC(5,2) AS pct_gg,
          (100.0 * COUNT(*) FILTER (WHERE h.home_goals > 0) / COUNT(*))::NUMERIC(5,2) AS pct_home_scores,
          (100.0 * COUNT(*) FILTER (WHERE h.away_goals > 0) / COUNT(*))::NUMERIC(5,2) AS pct_away_scores
        FROM h2h h
        JOIN pairs p ON h.team1_id = p.t1 AND h.team2_id = p.t2
        WHERE h.match_date >= NOW() - INTERVAL '4 years'
        GROUP BY h.team1_id, h.team2_id
      `, [t1arr, t2arr]).catch(() => ({ rows: [] }));
      h2hMap = Object.fromEntries(h2hRows.map(r => [`${r.team1_id}-${r.team2_id}`, r]));
    }

    // Load form_stats for all teams
    const allTeamIds = [...new Set([
      ...rawMatches.map(m => m.teams?.home?.id),
      ...rawMatches.map(m => m.teams?.away?.id),
    ].filter(Boolean))];
    const { rows: fsRows } = await query(
      'SELECT * FROM form_stats WHERE team_id = ANY($1)', [allTeamIds]
    ).catch(() => ({ rows: [] }));
    const formMap = {};
    for (const r of fsRows) {
      const k = `${r.team_id}-${r.league_id}`;
      if (!formMap[k] || formMap[k].season < r.season) formMap[k] = r;
    }

    // Build result
    const result = rawMatches.map(m => {
      const hid = m.teams?.home?.id;
      const aid = m.teams?.away?.id;
      const lid = m.league?.id;
      const fid = m.fixture?.id;
      const refName = cleanRef(m.fixture?.referee);

      const lg = leagueMap[lid] || {};
      const ref = refName ? refMap[refName] : null;
      const h2h = h2hMap[`${Math.min(hid, aid)}-${Math.max(hid, aid)}`] || null;
      const hForm = formMap[`${hid}-${lid}`] || null;
      const aForm = formMap[`${aid}-${lid}`] || null;
      const isLive = mode === 'live';

      const liveCards = teamId => (m.events || []).filter(e =>
        e.team?.id === teamId && ['Yellow Card', 'Red Card', 'Yellow+Red Card'].includes(e.detail)
      ).length;

      return {
        fixture_id: fid,
        home_team:  m.teams?.home?.name || '?',
        away_team:  m.teams?.away?.name || '?',
        league_name: m.league?.name || '',
        league_id:  lid,
        is_live:    isLive,
        minute:     m.fixture?.status?.elapsed || 0,
        home_goals: m.goals?.home || 0,
        away_goals: m.goals?.away || 0,
        status_short: m.fixture?.status?.short || 'NS',
        match_date: m.fixture?.date || null,
        referee:    refName || null,
        league: {
          avg_goals:   +(lg.avg_goals_per_match) || 2.5,
          pct_over_15: +(lg.pct_over_15)         || 60,
          pct_over_25: +(lg.pct_over_25)         || 40,
          pct_gg:      +(lg.pct_gg)              || 50,
          avg_yellow:  +(lg.avg_yellow_cards)     || 3.5,
          avg_corners: +(lg.avg_corners)          || 9,
        },
        ref_stats: ref ? {
          avg_goals:     +(ref.avg_goals)         || 2.5,
          avg_yellow:    +(ref.avg_yellow_cards)  || 3.5,
          avg_corners:   +(ref.avg_corners)       || 9,
          avg_penalties: +(ref.avg_penalties)     || 0.1,
        } : null,
        h2h: h2h ? {
          total:            +(h2h.total),
          avg_goals:        +(h2h.avg_goals),
          pct_over_15:      +(h2h.pct_over_15),
          pct_over_25:      +(h2h.pct_over_25),
          pct_gg:           +(h2h.pct_gg),
          pct_home_scores:  +(h2h.pct_home_scores),
          pct_away_scores:  +(h2h.pct_away_scores),
        } : null,
        form: {
          home_avg_scored:   hForm ? +(hForm.avg_scored_home)   : null,
          home_avg_conceded: hForm ? +(hForm.avg_conceded_home) : null,
          away_avg_scored:   aForm ? +(aForm.avg_scored_away)   : null,
          away_avg_conceded: aForm ? +(aForm.avg_conceded_away) : null,
          home_last5:        hForm?.last5_home || null,
          away_last5:        aForm?.last5_away || null,
        },
        live: isLive ? {
          home_xg:      getStat(m.statistics, hid, 'expected_goals'),
          away_xg:      getStat(m.statistics, aid, 'expected_goals'),
          home_sot:     getStat(m.statistics, hid, 'Shots on Goal'),
          away_sot:     getStat(m.statistics, aid, 'Shots on Goal'),
          home_corners: getStat(m.statistics, hid, 'Corner Kicks'),
          away_corners: getStat(m.statistics, aid, 'Corner Kicks'),
          home_cards:   liveCards(hid),
          away_cards:   liveCards(aid),
        } : null,
      };
    });

    return res.json({ ok: true, mode, count: result.length, matches: result });
  } catch (e) {
    console.error('[generator]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
