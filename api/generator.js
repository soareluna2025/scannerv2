import { query } from './db.js';
import { fetchApiFootball } from './utils/fetch-api.js';
import { ALLOWED_LEAGUE_IDS } from './leagues.js';
import { isAllowedMatch } from './utils/league-filter.js';

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

// Helper care încarcă tabelele auxiliare (league_stats, form_stats, h2h, referee_stats,
// venues, injuries) pentru un set de meciuri și întoarce un obiect cu hărți indexate.
async function loadAuxData(rawMatches) {
  const leagueIds = [...new Set(rawMatches.map(m => m.league?.id).filter(Boolean))];
  const { rows: lsRows } = await query(
    'SELECT * FROM league_stats WHERE league_id = ANY($1)', [leagueIds]
  ).catch(() => ({ rows: [] }));
  const leagueMap = Object.fromEntries(lsRows.map(r => [Number(r.league_id), r]));

  const refNames = [...new Set(rawMatches.map(m => cleanRef(m.fixture?.referee)).filter(Boolean))];
  let refMap = {};
  if (refNames.length) {
    const { rows: rsRows } = await query(
      'SELECT * FROM referee_stats WHERE referee_name = ANY($1)', [refNames]
    ).catch(() => ({ rows: [] }));
    refMap = Object.fromEntries(rsRows.map(r => [r.referee_name, r]));
  }

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

  const allTeamIds = [...new Set([
    ...rawMatches.map(m => m.teams?.home?.id),
    ...rawMatches.map(m => m.teams?.away?.id),
  ].filter(Boolean))];

  const { rows: fsRows } = await query(
    'SELECT * FROM form_stats WHERE team_id = ANY($1)', [allTeamIds]
  ).catch(() => ({ rows: [] }));
  const formMap = {};
  const formByTeam = {};
  for (const r of fsRows) {
    const k = `${r.team_id}-${r.league_id}`;
    if (!formMap[k] || formMap[k].season < r.season) formMap[k] = r;
    if (!formByTeam[r.team_id] || formByTeam[r.team_id].season < r.season) {
      formByTeam[r.team_id] = r;
    }
  }

  const { rows: tsRows } = await query(
    `SELECT DISTINCT ON (team_id) team_id, avg_goals_for, avg_goals_against,
            clean_sheets_home, clean_sheets_away, played_home, played_away
     FROM teams_stats WHERE team_id = ANY($1) ORDER BY team_id, season DESC`,
    [allTeamIds]
  ).catch(() => ({ rows: [] }));
  const tsMap = Object.fromEntries(tsRows.map(r => [Number(r.team_id), r]));

  const venueIds = [...new Set(rawMatches.map(m => m._venue_id).filter(Boolean))];
  let venueMap = {};
  if (venueIds.length) {
    const { rows: vRows } = await query(
      'SELECT venue_id, surface FROM venues WHERE venue_id = ANY($1)',
      [venueIds]
    ).catch(() => ({ rows: [] }));
    venueMap = Object.fromEntries(vRows.map(r => [r.venue_id, r]));
  }

  const fixtureIds = rawMatches.map(m => m.fixture?.id).filter(Boolean);
  const injMap = {};
  if (fixtureIds.length) {
    const { rows: injRows } = await query(
      `SELECT fixture_id, team_id, COUNT(*) AS cnt
       FROM injuries WHERE fixture_id = ANY($1) GROUP BY fixture_id, team_id`,
      [fixtureIds]
    ).catch(() => ({ rows: [] }));
    for (const r of injRows) {
      if (!injMap[r.fixture_id]) injMap[r.fixture_id] = {};
      injMap[r.fixture_id][r.team_id] = Number(r.cnt);
    }
  }

  return { leagueMap, refMap, h2hMap, formMap, formByTeam, tsMap, venueMap, injMap };
}

// Construiește forma frontului așteptată de UI dintr-un rând rawMatch + aux data + predicție opțională.
function buildMatchResult(m, aux, pred = null) {
  const hid = m.teams?.home?.id;
  const aid = m.teams?.away?.id;
  const lid = m.league?.id;
  const fid = m.fixture?.id;
  const refName = cleanRef(m.fixture?.referee);
  const lg = aux.leagueMap[lid] || {};
  const ref = refName ? aux.refMap[refName] : null;
  const h2h = aux.h2hMap[`${Math.min(hid, aid)}-${Math.max(hid, aid)}`] || null;
  const hForm = aux.formMap[`${hid}-${lid}`] || aux.formByTeam[hid] || null;
  const aForm = aux.formMap[`${aid}-${lid}`] || aux.formByTeam[aid] || null;
  const hTS = aux.tsMap[hid] || null;
  const aTS = aux.tsMap[aid] || null;
  const venue = m._venue_id ? aux.venueMap[m._venue_id] || null : null;
  const isLive = LIVE_S.has(m.fixture?.status?.short);

  const liveCards = teamId => (m.events || []).filter(e =>
    e.team?.id === teamId && ['Yellow Card', 'Red Card', 'Yellow+Red Card'].includes(e.detail)
  ).length;

  const logoBase = 'https://media.api-sports.io/football/teams/';

  // Markets — preferă valorile din predictions când sunt disponibile, altfel rămân null
  const markets = pred ? {
    over15:      { prob: +(pred.over15_prob)     || 0, label: 'Over 1.5' },
    over25:      { prob: +(pred.over25_prob)     || 0, label: 'Over 2.5' },
    gg:          { prob: +(pred.gg_prob)         || 0, label: 'GG (Ambele marchează)' },
    home_scores: { prob: +(pred.home_score_rate) || 0, label: 'Gazde marchează' },
    away_scores: { prob: +(pred.away_score_rate) || 0, label: 'Oaspeți marchează' },
    h1:          { prob: +(pred.home_win_prob)   || 0, label: '1 (Victorie Gazde)' },
    draw:        { prob: +(pred.draw_prob)       || 0, label: 'X (Egal)' },
    h2:          { prob: +(pred.away_win_prob)   || 0, label: '2 (Victorie Oaspeți)' },
  } : null;

  return {
    fixture_id: fid,
    home_team:  m.teams?.home?.name || '?',
    away_team:  m.teams?.away?.name || '?',
    home_logo:  m.teams?.home?.logo || (hid ? `${logoBase}${hid}.png` : null),
    away_logo:  m.teams?.away?.logo || (aid ? `${logoBase}${aid}.png` : null),
    league_name:    m.league?.name    || '',
    league_country: m.league?.country || '',
    league_id:  lid,
    is_live:    isLive,
    minute:     m.fixture?.status?.elapsed || 0,
    home_goals: m.goals?.home || 0,
    away_goals: m.goals?.away || 0,
    status_short: m.fixture?.status?.short || 'NS',
    match_date: m.fixture?.date || null,
    referee:    refName || null,
    league: {
      avg_goals:   +(lg.avg_goals_per_match) || +(lg.avg_goals) || 2.5,
      pct_over_15: +(lg.pct_over_15)         || 60,
      pct_over_25: +(lg.pct_over_25)         || 40,
      pct_gg:      +(lg.pct_gg)              || 50,
      avg_yellow:  +(lg.avg_yellow_cards)    || +(lg.avg_yellow)  || 3.5,
      avg_corners: +(lg.avg_corners)         || 9,
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
      home_avg_scored:   hForm ? +(hForm.avg_scored_home)   : (hTS ? +(hTS.avg_goals_for)     : null),
      home_avg_conceded: hForm ? +(hForm.avg_conceded_home) : (hTS ? +(hTS.avg_goals_against) : null),
      away_avg_scored:   aForm ? +(aForm.avg_scored_away)   : (aTS ? +(aTS.avg_goals_for)     : null),
      away_avg_conceded: aForm ? +(aForm.avg_conceded_away) : (aTS ? +(aTS.avg_goals_against) : null),
      home_last5:        hForm?.last5_home || null,
      away_last5:        aForm?.last5_away || null,
      home_cs_rate: hTS && hTS.played_home > 0
        ? +(hTS.clean_sheets_home / hTS.played_home).toFixed(2) : null,
      away_cs_rate: aTS && aTS.played_away > 0
        ? +(aTS.clean_sheets_away / aTS.played_away).toFixed(2) : null,
      _ts_fallback: !hForm || !aForm,
    },
    venue_surface: venue?.surface || null,
    injuries: {
      home: aux.injMap[fid]?.[hid] || 0,
      away: aux.injMap[fid]?.[aid] || 0,
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
    // Date din predictions (sursa de adevăr pentru ordonarea Top 10)
    lambda_home:  pred ? +(pred.lambda_home)  : null,
    lambda_away:  pred ? +(pred.lambda_away)  : null,
    lambda_total: pred ? +(pred.lambda_total) : null,
    confidence:   pred ? +(pred.confidence)   : null,
    best_ev:      pred && pred.best_ev   != null ? +(pred.best_ev)   : null,
    best_cota:    pred && pred.best_cota != null ? +(pred.best_cota) : null,
    best_bet:     pred ? (pred.best_bet || null) : null,
    h2h_over15:   pred && pred.h2h_over15 != null ? +(pred.h2h_over15) : null,
    has_form_data:        !!(hForm || hTS) && !!(aForm || aTS),
    has_same_league_form: !!(aux.formMap[`${hid}-${lid}`]) && !!(aux.formMap[`${aid}-${lid}`]),
    markets,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const mode = (req.query?.mode || 'prematch').toLowerCase();

  try {
    let rawMatches = [];
    let predMap = {};

    if (mode === 'live') {
      if (!KEY) return res.status(500).json({ ok: false, error: 'No API key' });
      const r = await fetchApiFootball('/fixtures?live=all');
      const d = await r.json();
      rawMatches = (d.response || [])
        .filter(m => LIVE_S.has(m.fixture?.status?.short))
        .map(m => ({ ...m, _venue_id: m.fixture?.venue?.id || null }));

      // Enrich high-priority live matches cu statistici proaspete
      const priorityMatches = rawMatches.filter(m => {
        const min = m.fixture?.status?.elapsed ?? 0;
        const hg  = m.goals?.home ?? 0;
        const ag  = m.goals?.away ?? 0;
        return min > 45 || (hg + ag === 0 && min >= 30);
      }).slice(0, 10);
      await Promise.allSettled(priorityMatches.map(async m => {
        try {
          const sr = await fetchApiFootball(`/fixtures/statistics?fixture=${m.fixture.id}`);
          const sd = await sr.json();
          if (Array.isArray(sd.response) && sd.response.length) m.statistics = sd.response;
        } catch (_) {}
      }));

      rawMatches = rawMatches.filter(m => isAllowedMatch(m, ALLOWED_LEAGUE_IDS));

      // Atașează predicțiile existente din DB pentru meciurile live (dacă există)
      const fids = rawMatches.map(m => m.fixture?.id).filter(Boolean);
      if (fids.length) {
        const { rows: pRows } = await query(
          'SELECT * FROM predictions WHERE fixture_id = ANY($1)',
          [fids]
        ).catch(() => ({ rows: [] }));
        predMap = Object.fromEntries(pRows.map(r => [r.fixture_id, r]));
      }
    } else {
      // PREMATCH — top 10 din predictions cu confidence >=70 și over15_prob >=70
      const { rows } = await query(
        `SELECT p.fixture_id, p.home_team, p.away_team, p.league_name AS pred_league_name,
                p.lambda_home, p.lambda_away, p.lambda_total,
                p.over15_prob, p.over25_prob, p.gg_prob,
                p.home_win_prob, p.draw_prob, p.away_win_prob,
                p.home_score_rate, p.away_score_rate,
                p.h2h_over15, p.confidence, p.best_ev, p.best_cota, p.best_bet,
                f.match_date, f.status_short, f.referee, f.venue_id,
                f.home_team_id, f.away_team_id,
                f.home_team_name, f.away_team_name,
                f.league_id,
                l.name    AS league_name,
                l.country AS league_country,
                th.logo   AS home_logo,
                ta.logo   AS away_logo
           FROM predictions p
           JOIN fixtures f ON f.fixture_id = p.fixture_id
           LEFT JOIN leagues l ON l.league_id = f.league_id
           LEFT JOIN teams th  ON th.team_id  = f.home_team_id
           LEFT JOIN teams ta  ON ta.team_id  = f.away_team_id
          WHERE f.status_short = 'NS'
            AND f.match_date BETWEEN NOW() AND NOW() + INTERVAL '36 hours'
            AND p.confidence  >= 70
            AND p.over15_prob >= 70
          ORDER BY p.confidence DESC
          LIMIT 10`
      );

      rawMatches = rows.map(row => {
        predMap[row.fixture_id] = row;
        const logoBase = 'https://media.api-sports.io/football/teams/';
        return {
          _db: true,
          _venue_id: row.venue_id || null,
          fixture: { id: row.fixture_id, date: row.match_date, referee: row.referee,
                     status: { short: 'NS', elapsed: 0 } },
          league: { id: row.league_id, name: row.league_name || row.pred_league_name || '',
                    country: row.league_country || null },
          teams: {
            home: { id: row.home_team_id, name: row.home_team || row.home_team_name,
                    logo: row.home_logo || `${logoBase}${row.home_team_id}.png` },
            away: { id: row.away_team_id, name: row.away_team || row.away_team_name,
                    logo: row.away_logo || `${logoBase}${row.away_team_id}.png` },
          },
          goals: { home: null, away: null },
          statistics: [], events: [],
        };
      });
    }

    if (!rawMatches.length) return res.json({ ok: true, mode, count: 0, matches: [] });

    const aux = await loadAuxData(rawMatches);

    const result = rawMatches.map(m => {
      const fid = m.fixture?.id;
      const pred = fid ? (predMap[fid] || null) : null;
      return buildMatchResult(m, aux, pred);
    });

    return res.json({ ok: true, mode, count: result.length, matches: result });
  } catch (e) {
    console.error('[generator]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
