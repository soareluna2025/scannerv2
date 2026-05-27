import { query } from './db.js';
import { fetchApiFootball } from './utils/fetch-api.js';
import { ALLOWED_LEAGUE_IDS } from './leagues.js';
import { isAllowedMatch } from './utils/league-filter.js';
import { calcPoisson6x6, poissonProbOver } from './calc-utils.js';

const KEY = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
const LIVE_S = new Set(['1H','HT','2H','ET','BT','P','SUSP','INT','LIVE']);

// Calculează toate piețele pentru un meci folosind datele disponibile
function calcMatchMarkets(form, h2h, lg, ref) {
  const lgGoals   = +(lg.avg_goals)   || 2.5;
  const lgYellow  = +(lg.avg_yellow)  || 3.5;
  const lgCorners = +(lg.avg_corners) || 9.0;

  const hAvgS = form.home_avg_scored   ?? lgGoals * 0.55;
  const hAvgC = form.home_avg_conceded ?? lgGoals * 0.45;
  const aAvgS = form.away_avg_scored   ?? lgGoals * 0.45;
  const aAvgC = form.away_avg_conceded ?? lgGoals * 0.55;

  const lambdaH = Math.max(0.3, (hAvgS + aAvgC) / 2);
  const lambdaA = Math.max(0.3, (aAvgS + hAvgC) / 2);

  const matrix = calcPoisson6x6(lambdaH, lambdaA);

  // Blend cu H2H dacă există minim 5 meciuri (40% greutate H2H)
  const h2nSample = h2h?.total || 0;
  const blend = (poisson, h2hPct) =>
    h2nSample >= 5 ? Math.round(poisson * 0.60 + h2hPct * 0.40) : poisson;

  const over05 = matrix.over05Prob;
  const over15 = blend(matrix.over15Prob, +(h2h?.pct_over_15) || matrix.over15Prob);
  const over25 = blend(matrix.over25Prob, +(h2h?.pct_over_25) || matrix.over25Prob);
  const gg     = blend(matrix.ggProb,     +(h2h?.pct_gg)      || matrix.ggProb);

  const homeScores = blend(
    Math.min(99, Math.round((1 - Math.exp(-lambdaH)) * 100)),
    +(h2h?.pct_home_scores) || Math.min(99, Math.round((1 - Math.exp(-lambdaH)) * 100))
  );
  const awayScores = blend(
    Math.min(99, Math.round((1 - Math.exp(-lambdaA)) * 100)),
    +(h2h?.pct_away_scores) || Math.min(99, Math.round((1 - Math.exp(-lambdaA)) * 100))
  );

  // Cartonașe — preferă media arbitrului dacă >=5 meciuri, altfel media ligii
  const hasRef = ref && Number(ref.total_matches) >= 5;
  const lambdaCards   = hasRef ? +(ref.avg_yellow)  || lgYellow  : lgYellow;
  const lambdaCorners = hasRef ? +(ref.avg_corners)  || lgCorners : lgCorners;

  return {
    over05:          { prob: over05,                              label: 'Over 0.5' },
    over15:          { prob: over15,                              label: 'Over 1.5' },
    over25:          { prob: over25,                              label: 'Over 2.5' },
    gg:              { prob: gg,                                  label: 'GG (Ambele marchează)' },
    home_scores:     { prob: homeScores,                          label: 'Gazde marchează' },
    away_scores:     { prob: awayScores,                          label: 'Oaspeți marchează' },
    h1:              { prob: matrix.homeWin,                      label: '1 (Victorie Gazde)' },
    draw:            { prob: matrix.draw,                         label: 'X (Egal)' },
    h2:              { prob: matrix.awayWin,                      label: '2 (Victorie Oaspeți)' },
    dc1x:            { prob: Math.min(100, matrix.homeWin + matrix.draw),  label: '1X' },
    dcx2:            { prob: Math.min(100, matrix.draw + matrix.awayWin),  label: 'X2' },
    cards_over35:    { prob: poissonProbOver(lambdaCards,   3),   label: 'Cartonașe Over 3.5' },
    cards_over45:    { prob: poissonProbOver(lambdaCards,   4),   label: 'Cartonașe Over 4.5' },
    corners_over85:  { prob: poissonProbOver(lambdaCorners, 8),   label: 'Cornere Over 8.5' },
    corners_over95:  { prob: poissonProbOver(lambdaCorners, 9),   label: 'Cornere Over 9.5' },
  };
}

// Construiește biletul compus optim pentru ținta de cotă [targetMin, targetMax]
// Logica: câte UN singur pick per piață (cel mai bun meci din toate pentru acea piață)
// Over 0.5 exclus — nu există la bookmakers mainstream
function buildAccumulator(matches, targetMin = 1.50, targetMax = 2.00) {
  const MIN_PROB = 62;

  // Ordinea piețelor — de la cele mai comune la cele mai de nișă
  // Over 0.5 lipsește intenționat (nu există la bookmakers)
  const MARKET_ORDER = [
    'over15', 'gg', 'home_scores', 'away_scores',
    'corners_over85', 'cards_over35', 'dc1x', 'dcx2',
    'over25', 'corners_over95', 'cards_over45',
    'h1', 'h2', 'draw',
  ];

  // Grupează toate pick-urile valide per piață, sortate DESC prob
  const byMarket = {};
  for (const m of matches) {
    if (!m.markets) continue;
    for (const [key, mkt] of Object.entries(m.markets)) {
      if (!MARKET_ORDER.includes(key)) continue; // sare over05 + orice neinclus
      if (mkt.prob < MIN_PROB) continue;
      if (!byMarket[key]) byMarket[key] = [];
      byMarket[key].push({
        fixture_id:  m.fixture_id,
        match:       `${m.home_team} vs ${m.away_team}`,
        league:      m.league_name,
        match_date:  m.match_date,
        home_logo:   m.home_logo,
        away_logo:   m.away_logo,
        market_key:  key,
        label:       mkt.label,
        prob:        mkt.prob,
        fair_odds:   Math.round((100 / mkt.prob) * 100) / 100,
      });
    }
  }
  for (const key of Object.keys(byMarket)) {
    byMarket[key].sort((a, b) => b.prob - a.prob);
  }

  // Greedy: pentru fiecare piață în ordine, ia cel mai bun meci neutilizat
  const selected = [];
  const usedFixtures = new Set();
  let combinedOdds = 1.0;

  for (const key of MARKET_ORDER) {
    if (combinedOdds >= targetMin) break;
    if (!byMarket[key]) continue;

    // Cel mai bun meci pentru această piață care nu a mai fost folosit
    const pick = byMarket[key].find(p => !usedFixtures.has(p.fixture_id));
    if (!pick) continue;

    const newOdds = combinedOdds * pick.fair_odds;
    if (newOdds > targetMax * 1.2) continue; // ar depăși limita — sari

    selected.push(pick);
    combinedOdds = Math.round(newOdds * 100) / 100;
    usedFixtures.add(pick.fixture_id);
  }

  const combinedProb = Math.round(
    selected.reduce((p, s) => p * (s.prob / 100), 1) * 100
  );

  return {
    selections:    selected,
    combined_odds: Math.round(combinedOdds * 100) / 100,
    combined_prob: combinedProb,
    target_met:    combinedOdds >= targetMin,
    note: combinedOdds < targetMin
      ? 'Meciuri insuficiente azi pentru target. Măriți MIN_PROB sau adăugați mai multe meciuri.'
      : null,
  };
}

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
      const r = await fetchApiFootball('/fixtures?live=all');
      const d = await r.json();
      rawMatches = (d.response || []).filter(m => LIVE_S.has(m.fixture?.status?.short))
        .map(m => ({ ...m, _venue_id: m.fixture?.venue?.id || null }));

      // M7: Enrich high-priority live matches with fresh statistics
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
    } else {
      const now = new Date();
      const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const { rows } = await query(
        `SELECT f.fixture_id, f.league_id, f.home_team_id, f.away_team_id,
                COALESCE(th.name, f.home_team_name) AS home_name,
                COALESCE(ta.name, f.away_team_name) AS away_name,
                th.logo AS home_logo, ta.logo AS away_logo,
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
        let refStr = null, venueId = null;
        const pd = row.pd_fixture;
        if (Array.isArray(pd) && pd[0]?.fixture?.referee) refStr = pd[0].fixture.referee;
        if (Array.isArray(pd) && pd[0]?.fixture?.venue?.id) venueId = pd[0].fixture.venue.id;
        return {
          _db: true,
          _venue_id: venueId,
          fixture: { id: row.fixture_id, date: row.match_date, referee: refStr, status: { short: 'NS', elapsed: 0 } },
          league: { id: row.league_id, name: row.league_name },
          teams: {
            home: { id: row.home_team_id, name: row.home_name, logo: row.home_logo || `https://media.api-sports.io/football/teams/${row.home_team_id}.png` },
            away: { id: row.away_team_id, name: row.away_name, logo: row.away_logo || `https://media.api-sports.io/football/teams/${row.away_team_id}.png` },
          },
          goals: { home: null, away: null },
          statistics: [], events: [],
        };
      });
    }

    // Filtru centralizat — elimină feminin/tineret/ligi inferioare
    rawMatches = rawMatches.filter(m => isAllowedMatch(m, ALLOWED_LEAGUE_IDS));

    if (!rawMatches.length) return res.json({ ok: true, mode, count: 0, matches: [] });

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

    // Load teams_stats as fallback when form_stats missing (season-level averages)
    const { rows: tsRows } = await query(
      `SELECT DISTINCT ON (team_id) team_id, avg_goals_for, avg_goals_against,
              clean_sheets_home, clean_sheets_away, played_home, played_away
       FROM teams_stats WHERE team_id = ANY($1) ORDER BY team_id, season DESC`,
      [allTeamIds]
    ).catch(() => ({ rows: [] }));
    const tsMap = Object.fromEntries(tsRows.map(r => [Number(r.team_id), r]));

    // Load venues for surface type (artificial turf bonus)
    const venueIds = [...new Set(rawMatches.map(m => m._venue_id).filter(Boolean))];
    let venueMap = {};
    if (venueIds.length) {
      const { rows: vRows } = await query(
        'SELECT venue_id, surface FROM venues WHERE venue_id = ANY($1)',
        [venueIds]
      ).catch(() => ({ rows: [] }));
      venueMap = Object.fromEntries(vRows.map(r => [r.venue_id, r]));
    }

    // Load injuries per fixture (batch grouped by fixture_id + team_id)
    const fixtureIds = rawMatches.map(m => m.fixture?.id).filter(Boolean);
    let injMap = {};
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
      const hTS   = tsMap[hid] || null;
      const aTS   = tsMap[aid] || null;
      const venue = m._venue_id ? venueMap[m._venue_id] || null : null;
      const isLive = mode === 'live';

      const liveCards = teamId => (m.events || []).filter(e =>
        e.team?.id === teamId && ['Yellow Card', 'Red Card', 'Yellow+Red Card'].includes(e.detail)
      ).length;

      const logoBase = 'https://media.api-sports.io/football/teams/';
      return {
        fixture_id: fid,
        home_team:  m.teams?.home?.name || '?',
        away_team:  m.teams?.away?.name || '?',
        home_logo:  m.teams?.home?.logo || (hid ? `${logoBase}${hid}.png` : null),
        away_logo:  m.teams?.away?.logo || (aid ? `${logoBase}${aid}.png` : null),
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
          // Priority: form_stats (recent 5) → teams_stats (season) → null
          home_avg_scored:   hForm ? +(hForm.avg_scored_home)   : (hTS ? +(hTS.avg_goals_for)     : null),
          home_avg_conceded: hForm ? +(hForm.avg_conceded_home) : (hTS ? +(hTS.avg_goals_against) : null),
          away_avg_scored:   aForm ? +(aForm.avg_scored_away)   : (aTS ? +(aTS.avg_goals_for)     : null),
          away_avg_conceded: aForm ? +(aForm.avg_conceded_away) : (aTS ? +(aTS.avg_goals_against) : null),
          home_last5:        hForm?.last5_home || null,
          away_last5:        aForm?.last5_away || null,
          // Clean sheet rates from teams_stats (for GG penalty in frontend scoring)
          home_cs_rate: hTS && hTS.played_home > 0
            ? +(hTS.clean_sheets_home / hTS.played_home).toFixed(2) : null,
          away_cs_rate: aTS && aTS.played_away > 0
            ? +(aTS.clean_sheets_away / aTS.played_away).toFixed(2) : null,
          _ts_fallback: !hForm || !aForm,
        },
        venue_surface: venue?.surface || null,
        injuries: {
          home: injMap[fid]?.[hid] || 0,
          away: injMap[fid]?.[aid] || 0,
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
        markets: calcMatchMarkets(
          {
            home_avg_scored:   hForm ? +(hForm.avg_scored_home)   : (hTS ? +(hTS.avg_goals_for)     : null),
            home_avg_conceded: hForm ? +(hForm.avg_conceded_home) : (hTS ? +(hTS.avg_goals_against) : null),
            away_avg_scored:   aForm ? +(aForm.avg_scored_away)   : (aTS ? +(aTS.avg_goals_for)     : null),
            away_avg_conceded: aForm ? +(aForm.avg_conceded_away) : (aTS ? +(aTS.avg_goals_against) : null),
          },
          h2h,
          { avg_goals: +(lg.avg_goals) || 2.5, avg_yellow: +(lg.avg_yellow) || 3.5, avg_corners: +(lg.avg_corners) || 9.0 },
          ref && Number(ref.total_matches) >= 5 ? ref : null
        ),
      };
    });

    // ?action=accumulator — returnează biletul compus optim
    if (req.query?.action === 'accumulator') {
      const targetMin = parseFloat(req.query.target_min) || 1.50;
      const targetMax = parseFloat(req.query.target_max) || 2.00;
      const accum = buildAccumulator(result, targetMin, targetMax);
      return res.json({ ok: true, mode, accumulator: accum });
    }

    return res.json({ ok: true, mode, count: result.length, matches: result });
  } catch (e) {
    console.error('[generator]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
