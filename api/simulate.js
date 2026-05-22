import { runSimulation } from './monte-carlo.js';
import { calcMomentum }  from './match-momentum.js';
import { calcElo }       from './elo.js';
import { query }         from './db.js';

const cache = new Map();
const CACHE_TTL = 120000; // 2 minutes
const CACHE_MAX = 100;

function evictSimCache() {
  if (cache.size > CACHE_MAX) {
    [...cache.keys()].slice(0, Math.floor(CACHE_MAX / 2)).forEach(k => cache.delete(k));
  }
}

function statVal(arr, name) {
  const s = arr?.find(x => x.type === name);
  const v = s?.value;
  if (v == null) return 0;
  if (typeof v === 'string' && v.endsWith('%')) return parseFloat(v);
  return parseFloat(v) || 0;
}

async function apiFetch(path, key) {
  const r = await fetch(`https://v3.football.api-sports.io${path}`,
    { headers: { 'x-apisports-key': key } });
  const d = await r.json();
  return d.response || [];
}

// ── DB query helpers ─────────────────────────────────────────────────────────

async function sfHistoryForm(teamId) {
  try {
    const r = await query(
      `SELECT home_team_id, away_team_id, home_goals, away_goals, match_date
       FROM fixtures_history
       WHERE (home_team_id = $1 OR away_team_id = $1)
         AND status_short = 'FT' AND home_goals IS NOT NULL
       ORDER BY match_date DESC LIMIT 10`,
      [teamId]
    );
    return r.rows.map(row => ({
      fixture: { date: row.match_date },
      teams:   { home: { id: row.home_team_id }, away: { id: row.away_team_id } },
      goals:   { home: row.home_goals ?? 0, away: row.away_goals ?? 0 },
      statistics: [],
    }));
  } catch (_) { return []; }
}

async function sfFormTable(teamId, leagueId) {
  // form_stats: pre-computed season averages per home/away split
  try {
    const r = await query(
      `SELECT avg_scored_home, avg_conceded_home, avg_scored_away, avg_conceded_away,
              last5_home, last5_away
       FROM form_stats WHERE team_id = $1 AND league_id = $2
       ORDER BY season DESC LIMIT 1`,
      [teamId, leagueId]
    );
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    return {
      avgScoredHome:    Number(row.avg_scored_home)    || 0,
      avgConcededHome:  Number(row.avg_conceded_home)  || 0,
      avgScoredAway:    Number(row.avg_scored_away)    || 0,
      avgConcededAway:  Number(row.avg_conceded_away)  || 0,
      last5Home: row.last5_home || '',
      last5Away: row.last5_away || '',
    };
  } catch (_) { return null; }
}

async function sfLeagueStats(leagueId) {
  try {
    const r = await query(
      `SELECT avg_goals_per_match, avg_home_goals, avg_away_goals,
              pct_over_15, pct_over_25, pct_gg, total_matches
       FROM league_stats WHERE league_id = $1`,
      [leagueId]
    );
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    return {
      avgGoals:    Number(row.avg_goals_per_match) || 0,
      avgHome:     Number(row.avg_home_goals)      || 0,
      avgAway:     Number(row.avg_away_goals)      || 0,
      pctOver15:   Number(row.pct_over_15)         || 0,
      pctOver25:   Number(row.pct_over_25)         || 0,
      pctGG:       Number(row.pct_gg)              || 0,
      totalMatches: Number(row.total_matches)      || 0,
    };
  } catch (_) { return null; }
}

async function sfRefereeStats(refName) {
  if (!refName) return null;
  try {
    const r = await query(
      `SELECT avg_goals, referee_style, pct_over_25, pct_gg, avg_yellow_cards, total_matches
       FROM referee_stats WHERE referee_name = $1`,
      [refName]
    );
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    return {
      style:        row.referee_style || 'neutral',
      avgGoals:     Number(row.avg_goals)         || 0,
      pctOver25:    Number(row.pct_over_25)        || 0,
      pctGG:        Number(row.pct_gg)             || 0,
      avgYellow:    Number(row.avg_yellow_cards)   || 0,
      totalMatches: Number(row.total_matches)      || 0,
    };
  } catch (_) { return null; }
}

async function sfH2HStats(homeId, awayId) {
  try {
    const r = await query(
      `SELECT * FROM h2h
       WHERE (home_team_id = $1 AND away_team_id = $2)
          OR (home_team_id = $2 AND away_team_id = $1)
       ORDER BY match_date DESC LIMIT 10`,
      [homeId, awayId]
    );
    return r.rows;
  } catch (_) { return []; }
}

async function sfStandingsData(leagueId) {
  try {
    const r = await query(
      'SELECT * FROM standings WHERE league_id = $1 AND season = $2 ORDER BY rank ASC',
      [leagueId, new Date().getFullYear()]
    );
    return r.rows;
  } catch (_) { return []; }
}

async function sfOddsData(fixtureId) {
  try {
    const r = await query(
      `SELECT *, bet_name AS market, value_name AS label, value_odd AS odd_value
       FROM odds WHERE fixture_id = $1 ORDER BY bookmaker_id ASC`,
      [fixtureId]
    );
    return r.rows;
  } catch (_) { return []; }
}

async function sfInjuries(fixtureId) {
  try {
    const r = await query(
      `SELECT team_id, COUNT(*) AS cnt FROM injuries WHERE fixture_id = $1 GROUP BY team_id`,
      [fixtureId]
    );
    const m = {};
    for (const row of r.rows) m[Number(row.team_id)] = Number(row.cnt);
    return m;
  } catch (_) { return {}; }
}

// Real goal minute distribution from match_events
const FIFA_DISTRIBUTION = { '1-15': 14, '16-30': 15, '31-45': 18, '46-60': 16, '61-75': 18, '76-90': 19 };

async function sfGoalMinuteDistribution(leagueId) {
  const bands = [
    ['1-15', 1, 15], ['16-30', 16, 30], ['31-45', 31, 45],
    ['46-60', 46, 60], ['61-75', 61, 75], ['76-90', 76, 90],
  ];

  try {
    // League-specific distribution — join match_events with fixtures_history for league_id
    if (leagueId) {
      const { rows: lgRows } = await query(
        `SELECT
           CASE
             WHEN me.elapsed BETWEEN 1  AND 15 THEN '1-15'
             WHEN me.elapsed BETWEEN 16 AND 30 THEN '16-30'
             WHEN me.elapsed BETWEEN 31 AND 45 THEN '31-45'
             WHEN me.elapsed BETWEEN 46 AND 60 THEN '46-60'
             WHEN me.elapsed BETWEEN 61 AND 75 THEN '61-75'
             WHEN me.elapsed BETWEEN 76 AND 90 THEN '76-90'
           END AS band,
           COUNT(*) AS goals
         FROM match_events me
         JOIN fixtures_history fh ON fh.fixture_id = me.fixture_id
         WHERE me.type = 'Goal'
           AND me.elapsed BETWEEN 1 AND 90
           AND fh.league_id = $1
         GROUP BY band`,
        [leagueId]
      );
      const totalLg = lgRows.reduce((s, r) => s + Number(r.goals), 0);
      if (totalLg >= 50) {
        const dist = {};
        const map = Object.fromEntries(lgRows.map(r => [r.band, Number(r.goals)]));
        bands.forEach(([lbl]) => { dist[lbl] = totalLg > 0 ? Math.round((map[lbl] || 0) / totalLg * 100) : 0; });
        return { dist, source: `ligă (${totalLg} goluri)`, goalCount: totalLg };
      }
    }

    // Global fallback — all leagues
    const { rows: glRows } = await query(
      `SELECT
         CASE
           WHEN elapsed BETWEEN 1  AND 15 THEN '1-15'
           WHEN elapsed BETWEEN 16 AND 30 THEN '16-30'
           WHEN elapsed BETWEEN 31 AND 45 THEN '31-45'
           WHEN elapsed BETWEEN 46 AND 60 THEN '46-60'
           WHEN elapsed BETWEEN 61 AND 75 THEN '61-75'
           WHEN elapsed BETWEEN 76 AND 90 THEN '76-90'
         END AS band,
         COUNT(*) AS goals
       FROM match_events
       WHERE type = 'Goal' AND elapsed BETWEEN 1 AND 90
       GROUP BY band`
    );
    const totalGl = glRows.reduce((s, r) => s + Number(r.goals), 0);
    if (totalGl >= 100) {
      const dist = {};
      const map = Object.fromEntries(glRows.map(r => [r.band, Number(r.goals)]));
      bands.forEach(([lbl]) => { dist[lbl] = totalGl > 0 ? Math.round((map[lbl] || 0) / totalGl * 100) : 0; });
      return { dist, source: `global (${totalGl} goluri)`, goalCount: totalGl };
    }
  } catch (_) {}

  // FIFA statistical fallback
  return { dist: { ...FIFA_DISTRIBUTION }, source: 'statistică FIFA', goalCount: 0 };
}

async function sfModelWeight(module, contextKey, weightName) {
  try {
    const { rows } = await query(
      `SELECT weight_value FROM model_weights
       WHERE module=$1 AND context_key=$2 AND weight_name=$3 LIMIT 1`,
      [module, contextKey, weightName]
    );
    return rows[0] ? Number(rows[0].weight_value) : null;
  } catch (_) { return null; }
}

async function sfPlayerStats(teamId, label, dq) {
  try {
    const r = await query(
      'SELECT * FROM player_stats WHERE team_id = $1 ORDER BY fixture_id DESC LIMIT 100',
      [teamId]
    );
    dq[label] = r.rows.length ? '✅' : '⚠️';
    return r.rows;
  } catch (_) { dq[label] = '❌'; return []; }
}

// ── Data format helpers ──────────────────────────────────────────────────────

function h2hToSimFormat(rows) {
  return rows.map(row => ({
    fixture: { date: row.match_date },
    teams:   { home: { id: row.home_team_id }, away: { id: row.away_team_id } },
    goals:   { home: row.home_goals ?? 0, away: row.away_goals ?? 0 },
    statistics: [],
  }));
}

function sbStandingsToApiFormat(rows) {
  return [{ league: { standings: [rows.map(row => ({
    team:      { id: row.team_id, name: row.team_name },
    rank:      row.rank, points: row.points, goalsDiff: row.goals_diff, form: row.form,
    all: { played: row.played, win: row.win, draw: row.draw, lose: row.lose,
           goals: { for: row.goals_for, against: row.goals_against } },
    home: { played: null }, away: { played: null },
  }))] } }];
}

function sbOddsToApiFormat(rows) {
  if (!rows.length) return [];
  const bkmMap = {};
  for (const row of rows) {
    if (!bkmMap[row.bookmaker_id])
      bkmMap[row.bookmaker_id] = { id: row.bookmaker_id, name: row.bookmaker_name, bets: {} };
    if (!bkmMap[row.bookmaker_id].bets[row.market])
      bkmMap[row.bookmaker_id].bets[row.market] = [];
    bkmMap[row.bookmaker_id].bets[row.market].push({ value: row.label, odd: String(row.odd_value) });
  }
  return [{ bookmakers: Object.values(bkmMap).map(bkm => ({
    id: bkm.id, name: bkm.name,
    bets: Object.entries(bkm.bets).map(([name, values]) => ({ name, values })),
  })) }];
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  const q   = req.method === 'POST' ? (req.body || {}) : req.query;
  const fid = Number(q.fixture_id);
  const hid = Number(q.home_id);
  const aid = Number(q.away_id);
  const lid = Number(q.league_id) || 0;

  if (!fid || !hid || !aid)
    return res.status(400).json({ error: 'fixture_id, home_id, away_id required' });

  const ck  = String(fid);
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return res.status(200).json(hit.data);

  const dq = {};
  const season = new Date().getFullYear();

  async function af(path, label) {
    try {
      const r = await apiFetch(path, key);
      dq[label] = r.length ? '✅' : '⚠️';
      return r;
    } catch { dq[label] = '❌'; return []; }
  }

  // ── Batch 1: fixture (API-Football) + toate sursele DB în paralel ──────────
  const [
    fixRes, lineupsRes,
    sbHomeFx, sbAwayFx, sbH2HData, sbStdData, sbOddsData,
    homePlayers, awayPlayers, injData,
    homeFormTable, awayFormTable, leagueStats,
    lambdaMult,
    goalMinDist,
  ] = await Promise.all([
    af(`/fixtures?id=${fid}`,              'fixture'),
    af(`/fixtures/lineups?fixture=${fid}`, 'lineups'),
    sfHistoryForm(hid),
    sfHistoryForm(aid),
    sfH2HStats(hid, aid),
    lid ? sfStandingsData(lid) : Promise.resolve([]),
    sfOddsData(fid),
    sfPlayerStats(hid, 'homePlayers', dq),
    sfPlayerStats(aid, 'awayPlayers', dq),
    sfInjuries(fid),
    lid ? sfFormTable(hid, lid) : Promise.resolve(null),   // form_stats season avg
    lid ? sfFormTable(aid, lid) : Promise.resolve(null),
    lid ? sfLeagueStats(lid)    : Promise.resolve(null),   // league_stats real avg
    lid ? sfModelWeight('OVER15', `league_${lid}`, 'lambda_multiplier') : Promise.resolve(null),
    sfGoalMinuteDistribution(lid || 0),
  ]);

  // Fixture basics — needed before batch 2
  const fix      = fixRes[0] || null;
  const fixStatus = fix?.fixture?.status?.short || 'NS';
  const isLive   = ['1H','2H','HT','ET','BT','P','LIVE','INT'].includes(fixStatus);
  const elapsed  = fix?.fixture?.status?.elapsed || 0;
  const hgCur    = fix?.goals?.home ?? 0;
  const agCur    = fix?.goals?.away ?? 0;
  const homeName = fix?.teams?.home?.name || 'Gazde';
  const awayName = fix?.teams?.away?.name || 'Oaspeți';
  const refName  = fix?.fixture?.referee  || null;

  const needHomeFx = sbHomeFx.length < 3;
  const needAwayFx = sbAwayFx.length < 3;
  const needH2H    = sbH2HData.length < 3;
  const needStd    = lid && sbStdData.length === 0;
  const needOdds   = sbOddsData.length === 0;

  // ── Batch 2: API fallbacks + live statistics + referee stats ──────────────
  const [apiFbHomeFx, apiFbAwayFx, apiFbH2H, apiFbStd, apiFbOdds, liveStatsRes, refStats] = await Promise.all([
    needHomeFx ? af(`/fixtures?team=${hid}&last=10&status=FT`,        'homeFormFb')  : Promise.resolve(null),
    needAwayFx ? af(`/fixtures?team=${aid}&last=10&status=FT`,        'awayFormFb')  : Promise.resolve(null),
    needH2H    ? af(`/fixtures/headtohead?h2h=${hid}-${aid}&last=10`, 'h2hFb')      : Promise.resolve(null),
    needStd    ? af(`/standings?league=${lid}&season=${season}`,      'standingsFb') : Promise.resolve(null),
    needOdds   ? af(`/odds?fixture=${fid}&bookmaker=8`,               'oddsFb')     : Promise.resolve(null),
    isLive     ? af(`/fixtures/statistics?fixture=${fid}`,            'liveStats')  : Promise.resolve([]),
    sfRefereeStats(refName),
  ]);

  // Resolve final datasets
  const homeFx     = needHomeFx ? (apiFbHomeFx || []) : sbHomeFx;
  const awayFx     = needAwayFx ? (apiFbAwayFx || []) : sbAwayFx;
  const h2hFx      = needH2H    ? (apiFbH2H    || []) : h2hToSimFormat(sbH2HData);
  const standingsRes = needStd
    ? (apiFbStd || [])
    : (sbStdData.length ? sbStandingsToApiFormat(sbStdData) : []);
  const oddsRes    = needOdds ? (apiFbOdds || []) : sbOddsToApiFormat(sbOddsData);

  // Live stats from dedicated statistics endpoint (real live data)
  const hSt = liveStatsRes[0]?.statistics || fix?.statistics?.[0]?.statistics || [];
  const aSt = liveStatsRes[1]?.statistics || fix?.statistics?.[1]?.statistics || [];

  const liveStats = isLive ? {
    minute: elapsed, homeGoals: hgCur, awayGoals: agCur,
    homexG: statVal(hSt, 'expected_goals') || statVal(hSt, 'xG'),
    awayxG: statVal(aSt, 'expected_goals') || statVal(aSt, 'xG'),
    homePossession:       statVal(hSt, 'Ball Possession') || 50,
    homeShotsOnTarget:    statVal(hSt, 'Shots on Goal'),
    awayShotsOnTarget:    statVal(aSt, 'Shots on Goal'),
    homeDangerousAttacks: statVal(hSt, 'Dangerous Attacks'),
    awayDangerousAttacks: statVal(aSt, 'Dangerous Attacks'),
    homeCorners: statVal(hSt, 'Corner Kicks'),
    awayCorners: statVal(aSt, 'Corner Kicks'),
  } : null;

  // ── Form from fixtures_history ────────────────────────────────────────────
  function calcHistoryForm(matches, teamId) {
    if (!matches.length) return null;
    let gS = 0, gC = 0, xgF = 0, xgA = 0, sot = 0, poss = 0, wins = 0, cs = 0;
    const form5 = [];
    const sorted = [...matches].sort((a, b) => new Date(b.fixture?.date) - new Date(a.fixture?.date));
    for (const m of sorted) {
      const ih = m.teams?.home?.id === teamId;
      const gs = ih ? (m.goals?.home ?? 0) : (m.goals?.away ?? 0);
      const gc = ih ? (m.goals?.away ?? 0) : (m.goals?.home ?? 0);
      gS += gs; gC += gc;
      if (gc === 0) cs++;
      if (gs > gc) wins++;
      if (form5.length < 5) form5.push(gs > gc ? 'W' : gs === gc ? 'D' : 'L');
      const tSt = (ih ? m.statistics?.[0] : m.statistics?.[1])?.statistics || [];
      const oSt = (ih ? m.statistics?.[1] : m.statistics?.[0])?.statistics || [];
      xgF  += statVal(tSt, 'expected_goals') || gs;
      xgA  += statVal(oSt, 'expected_goals') || gc;
      sot  += statVal(tSt, 'Shots on Goal');
      poss += statVal(tSt, 'Ball Possession') || 50;
    }
    const n = matches.length;
    return {
      goalsScored:   +(gS / n).toFixed(2),
      goalsConceded: +(gC / n).toFixed(2),
      xGFor:         +(xgF / n).toFixed(2),
      xGAgainst:     +(xgA / n).toFixed(2),
      shotsOnTarget: +(sot  / n).toFixed(2),
      possession:    Math.round(poss / n),
      winRate:       Math.round(wins / n * 100),
      cleanSheets:   Math.round(cs   / n * 100),
      form5,
    };
  }

  const homeHistForm = calcHistoryForm(homeFx, hid);
  const awayHistForm = calcHistoryForm(awayFx, aid);

  // ── Squad strength from player_stats ─────────────────────────────────────
  function calcSquad(players) {
    if (!players.length) return null;
    // pg returns NUMERIC as strings — force Number() to avoid string-concat NaN
    const ratings   = players.map(p => p.rating).filter(r => r != null).map(Number);
    const avgRating  = ratings.length ? ratings.reduce((s, r) => s + r, 0) / ratings.length : 7.0;
    const avgPassAcc = players.reduce((s, p) => s + (Number(p.pass_accuracy)   || 0), 0) / players.length;
    const avgSOT     = players.reduce((s, p) => s + (Number(p.shots_on_target) || 0), 0) / players.length;
    const topScorer  = players.reduce((b, p) => (Number(p.goals) || 0) > (Number(b.goals) || 0) ? p : b, {});
    const key3       = [...players].sort((a, b) => (Number(b.player_score) || 0) - (Number(a.player_score) || 0)).slice(0, 3);
    const strength   = Math.round(
      (avgRating / 10 * 100) * 0.35 +
      Math.min(100, avgSOT * 12)                        * 0.25 +
      avgPassAcc                                         * 0.20 +
      Math.min(100, (Number(topScorer.goals) || 0) * 20) * 0.20
    );
    return {
      avgRating:        +avgRating.toFixed(2),
      avgPassAccuracy:  +avgPassAcc.toFixed(1),
      avgShotsOnTarget: +avgSOT.toFixed(1),
      topScorer: { name: topScorer.player_name || '—', goals: Number(topScorer.goals) || 0 },
      keyPlayers: key3.map(p => ({ name: p.player_name, score: Number(p.player_score) })),
      strength,
      playerCount: players.length,
    };
  }

  const homeSquad = calcSquad(homePlayers);
  const awaySquad = calcSquad(awayPlayers);

  // ── League average — from league_stats (real data) or standings fallback ──
  const leagueTable = standingsRes[0]?.league?.standings?.[0] || [];
  const homeStd = leagueTable.find(s => s.team?.id === hid) || null;
  const awayStd = leagueTable.find(s => s.team?.id === aid) || null;

  let lgGoals, lgHomeGoals, lgAwayGoals, lgSource;
  if (leagueStats?.avgGoals > 0) {
    lgGoals     = leagueStats.avgGoals;
    lgHomeGoals = leagueStats.avgHome || lgGoals * 0.52;
    lgAwayGoals = leagueStats.avgAway || lgGoals * 0.48;
    lgSource    = 'league_stats';
  } else if (leagueTable.length) {
    const tGF  = leagueTable.reduce((s, t) => s + (t.all?.goals?.for || 0), 0);
    const tPld = leagueTable.reduce((s, t) => s + (t.all?.played     || 0), 0);
    lgGoals     = tPld ? +(tGF / tPld).toFixed(2) : 2.5;
    lgHomeGoals = lgGoals * 0.52;
    lgAwayGoals = lgGoals * 0.48;
    lgSource    = 'standings';
  } else {
    lgGoals     = 2.5;
    lgHomeGoals = 1.3;
    lgAwayGoals = 1.2;
    lgSource    = 'estimate';
  }

  // ── Lambda sources — priority: form_stats > fixtures_history > league_stats
  let hAvgS, hAvgC, hFormSource;
  if (homeFormTable?.avgScoredHome > 0) {
    hAvgS = homeFormTable.avgScoredHome;
    hAvgC = homeFormTable.avgConcededHome;
    hFormSource = 'form_stats';
    dq['homeForm'] = '✅';
  } else if (homeHistForm) {
    hAvgS = homeHistForm.goalsScored;
    hAvgC = homeHistForm.goalsConceded;
    hFormSource = 'fixtures_history';
    dq['homeForm'] = '✅';
  } else {
    hAvgS = lgHomeGoals;
    hAvgC = lgAwayGoals;
    hFormSource = lgSource;
    dq['homeForm'] = lgSource === 'estimate' ? '❌' : '⚠️';
  }

  let aAvgS, aAvgC, aFormSource;
  if (awayFormTable?.avgScoredAway > 0) {
    aAvgS = awayFormTable.avgScoredAway;
    aAvgC = awayFormTable.avgConcededAway;
    aFormSource = 'form_stats';
    dq['awayForm'] = '✅';
  } else if (awayHistForm) {
    aAvgS = awayHistForm.goalsScored;
    aAvgC = awayHistForm.goalsConceded;
    aFormSource = 'fixtures_history';
    dq['awayForm'] = '✅';
  } else {
    aAvgS = lgAwayGoals;
    aAvgC = lgHomeGoals;
    aFormSource = lgSource;
    dq['awayForm'] = lgSource === 'estimate' ? '❌' : '⚠️';
  }

  dq['h2h']       = sbH2HData.length  ? '✅' : (h2hFx.length ? '✅' : '⚠️');
  dq['standings'] = sbStdData.length  ? '✅' : '⚠️';
  dq['odds']      = sbOddsData.length ? '✅' : '⚠️';
  dq['leagueStats'] = leagueStats ? '✅' : '⚠️';
  dq['referee']   = refStats ? '✅' : (refName ? '⚠️' : '—');

  // ── ELO from historical matches ────────────────────────────────────────────
  const elo = calcElo(homeFx, awayFx, hid, aid, h2hFx);

  // ── Referee factor (real referee tendency data) ────────────────────────────
  const refFactor = refStats?.style === 'high_scorer' ? 1.10
                  : refStats?.style === 'low_scorer'  ? 0.92 : 1.0;

  // ── Injury factor ─────────────────────────────────────────────────────────
  const homeInjuries = injData[hid] || 0;
  const awayInjuries = injData[aid] || 0;
  const injFactorH   = homeInjuries >= 5 ? 0.90 : homeInjuries >= 3 ? 0.95 : 1.0;
  const injFactorA   = awayInjuries >= 5 ? 0.90 : awayInjuries >= 3 ? 0.95 : 1.0;

  // ── Attack/Defense indices relative to league avg ─────────────────────────
  const hAtt = lgHomeGoals > 0 ? hAvgS / lgHomeGoals : 1;
  const hDef = lgAwayGoals > 0 ? hAvgC / lgAwayGoals : 1;
  const aAtt = lgAwayGoals > 0 ? aAvgS / lgAwayGoals : 1;
  const aDef = lgHomeGoals > 0 ? aAvgC / lgHomeGoals : 1;

  const eloFactor = 1 + (elo.eloDiff / 4000);
  const pfHome    = homeSquad ? Math.min(1.3, homeSquad.avgRating / 7.0) : 1.0;
  const pfAway    = awaySquad ? Math.min(1.3, awaySquad.avgRating / 7.0) : 1.0;

  const safe = (v, fb) => Number.isFinite(v) ? v : fb;

  let lH = safe(Math.max(0.2, Math.min(4.0,
    hAtt * aDef * lgHomeGoals * eloFactor * pfHome * refFactor * injFactorH
  )), lgHomeGoals);
  let lA = safe(Math.max(0.2, Math.min(4.0,
    aAtt * hDef * lgAwayGoals / eloFactor * pfAway * refFactor * injFactorA
  )), lgAwayGoals);

  // ── Self-learning: apply league-specific lambda multiplier if calibrated ───
  const modelCalibrated = lambdaMult != null && lambdaMult !== 1.0;
  if (modelCalibrated) {
    lH = safe(Math.max(0.2, Math.min(4.0, lH * lambdaMult)), lH);
    lA = safe(Math.max(0.2, Math.min(4.0, lA * lambdaMult)), lA);
  }

  // ── Confidence interval margin based on available historical sample ────────
  const sampleSize = Math.min(
    (sbH2HData.length || h2hFx.length) + Math.min(homeFx.length, awayFx.length),
    150
  );
  const ciMargin = sampleSize < 10 ? 15 : sampleSize < 30 ? 10 : sampleSize < 100 ? 5 : 2;

  // ── Live adjustment using REAL live statistics ─────────────────────────────
  if (isLive && elapsed > 0) {
    const mRem  = Math.max(1, 90 - elapsed);
    const sotH  = statVal(hSt, 'Shots on Goal');
    const sotA  = statVal(aSt, 'Shots on Goal');
    const xGH   = statVal(hSt, 'expected_goals') || statVal(hSt, 'xG') || 0;
    const xGA   = statVal(aSt, 'expected_goals') || statVal(aSt, 'xG') || 0;
    const daH   = statVal(hSt, 'Dangerous Attacks');
    const daA   = statVal(aSt, 'Dangerous Attacks');

    // SoT rate per minute → pressure factor
    const sotRH   = elapsed > 0 ? sotH / elapsed : 0;
    const sotRA   = elapsed > 0 ? sotA / elapsed : 0;
    const pressH  = Math.min(1.4, 1 + sotRH * 8);
    const pressA  = Math.min(1.4, 1 + sotRA * 8);

    // xG complement: use real xG if available, else SoT-based estimate
    const xgCompH = xGH > 0 ? xGH * 0.25 : sotH * 0.08;
    const xgCompA = xGA > 0 ? xGA * 0.25 : sotA * 0.08;

    lH = Math.max(0.02, lH * (mRem / 90) * pressH + xgCompH);
    lA = Math.max(0.02, lA * (mRem / 90) * pressA + xgCompA);
  }

  // ── Monte Carlo simulation ────────────────────────────────────────────────
  const sim = runSimulation(lH, lA, 10000, isLive ? hgCur : 0, isLive ? agCur : 0);

  // ── Momentum ──────────────────────────────────────────────────────────────
  const momentum = liveStats ? calcMomentum(liveStats) : null;

  // ── Contextual factors that influenced the simulation ─────────────────────
  const factors = [];
  if (homeInjuries >= 3) factors.push({ icon: '🔴', text: `${homeInjuries} accidentați gazde`, impact: `-${Math.round((1 - injFactorH) * 100)}% goluri` });
  if (awayInjuries >= 3) factors.push({ icon: '🔴', text: `${awayInjuries} accidentați oaspeți`, impact: `-${Math.round((1 - injFactorA) * 100)}% goluri` });
  if (refStats) {
    if (refStats.style === 'high_scorer') {
      factors.push({ icon: '🟢', text: `Arbitru permisiv (${refName || ''})`, impact: `${refStats.avgGoals?.toFixed(1) || '?'} goluri/meci` });
    } else if (refStats.style === 'low_scorer') {
      factors.push({ icon: '🔴', text: `Arbitru restrictiv (${refName || ''})`, impact: `${refStats.avgGoals?.toFixed(1) || '?'} goluri/meci` });
    } else if (refStats.avgYellow > 0) {
      factors.push({ icon: '🟡', text: `Arbitru (${refName || ''})`, impact: `Avg ${refStats.avgYellow.toFixed(1)} galbene/meci` });
    }
  }
  if (Math.abs(elo.eloDiff) > 150) {
    factors.push({ icon: elo.eloDiff > 0 ? '🟢' : '🔴', text: `ELO diferență: ${elo.eloDiff > 0 ? '+' : ''}${elo.eloDiff}`, impact: elo.eloDiff > 0 ? 'Gazde superioare' : 'Oaspeți superiori' });
  }
  if (modelCalibrated) {
    factors.push({ icon: '🧠', text: 'Model calibrat din date reale', impact: `λ×${lambdaMult.toFixed(2)} (${fix?.league?.name || 'ligă'})` });
  }

  // ── Data quality ──────────────────────────────────────────────────────────
  const missing  = Object.values(dq).filter(v => v === '❌').length;
  const dqLevel  = missing === 0 ? 'HIGH' : missing <= 2 ? 'MED' : 'LOW';

  // ── Odds & recommendation ────────────────────────────────────────────────
  const allBookmakers = oddsRes[0]?.bookmakers || [];
  const bets = allBookmakers[0]?.bets || [];
  function odd(betName, val) {
    const bet = bets.find(b => b.name === betName);
    const ov  = bet?.values?.find(v => v.value === val);
    return ov ? parseFloat(ov.odd) : null;
  }

  const candidates = [
    { name: 'Over 1.5',  prob: sim.markets.over15,  cota: odd('Goals Over/Under', 'Over 1.5') },
    { name: 'Over 2.5',  prob: sim.markets.over25,  cota: odd('Goals Over/Under', 'Over 2.5') },
    { name: 'GG',        prob: sim.markets.gg,       cota: odd('Both Teams Score', 'Yes')      },
    { name: '1 Gazde',   prob: sim.results.homeWin,  cota: odd('Match Winner', 'Home')         },
    { name: 'X Egal',    prob: sim.results.draw,     cota: odd('Match Winner', 'Draw')         },
    { name: '2 Oaspeți', prob: sim.results.awayWin,  cota: odd('Match Winner', 'Away')         },
  ];
  let bestBet = null, bestEV = -Infinity;
  for (const c of candidates) {
    if (!c.cota || c.prob < 10) continue;
    const ev = (c.prob / 100) - (1 / c.cota);
    if (ev > bestEV) { bestEV = ev; bestBet = { ...c, ev }; }
  }

  // ── Response ──────────────────────────────────────────────────────────────
  const result = {
    fixture: {
      id: fid, homeTeam: homeName, awayTeam: awayName,
      league: fix?.league?.name || '',
      minute: elapsed, score: `${hgCur}-${agCur}`, status: fixStatus,
      referee: refName,
    },
    realData: {
      // Form sources — clearly labeled
      homeFormSource: hFormSource,
      awayFormSource: aFormSource,
      homeForm: homeHistForm ? {
        goalsScored: homeHistForm.goalsScored, xGFor: homeHistForm.xGFor,
        winRate: homeHistForm.winRate, form5: homeHistForm.form5,
        cleanSheets: homeHistForm.cleanSheets,
      } : (homeFormTable ? {
        goalsScored: homeFormTable.avgScoredHome, form5: homeFormTable.last5Home,
      } : null),
      awayForm: awayHistForm ? {
        goalsScored: awayHistForm.goalsScored, xGFor: awayHistForm.xGFor,
        winRate: awayHistForm.winRate, form5: awayHistForm.form5,
        cleanSheets: awayHistForm.cleanSheets,
      } : (awayFormTable ? {
        goalsScored: awayFormTable.avgScoredAway, form5: awayFormTable.last5Away,
      } : null),
      // Elo from historical matches
      homeElo: elo.homeElo, awayElo: elo.awayElo, eloDiff: elo.eloDiff,
      // Squad from player_stats
      homeSquadStrength: homeSquad?.strength ?? null,
      awaySquadStrength: awaySquad?.strength ?? null,
      homeTopScorer: homeSquad?.topScorer || null,
      awayTopScorer: awaySquad?.topScorer || null,
      // Injuries from injuries table
      homeInjuries, awayInjuries,
      // League stats from league_stats table
      leagueAvgGoals: lgGoals,
      leagueSource: lgSource,
      leagueOver15Pct: leagueStats?.pctOver15 ?? null,
      leagueGGPct:     leagueStats?.pctGG     ?? null,
      // Referee from referee_stats table
      referee: refName,
      refereeStyle: refStats?.style ?? null,
      refereeAvgGoals: refStats?.avgGoals ?? null,
      refereeMatches:  refStats?.totalMatches ?? null,
      // Standings
      homeStanding: homeStd ? { position: homeStd.rank, points: homeStd.points } : null,
      awayStanding: awayStd ? { position: awayStd.rank, points: awayStd.points } : null,
      dataQuality: dqLevel,
      dataSources: dq,
    },
    simulation: {
      lambdaHome: +lH.toFixed(3),
      lambdaAway: +lA.toFixed(3),
      simCount: 10000,
      isLive,
      elapsed,
      currentScore: isLive ? `${hgCur}-${agCur}` : null,
      results:               sim.results,
      markets:               sim.markets,
      scoreDistribution:     sim.scoreDistribution,
      mostLikelyScore:       sim.mostLikelyScore,
      secondMostLikelyScore: sim.secondMostLikelyScore,
      expectedScore: isLive
        ? `${+(hgCur + lH).toFixed(1)} - ${+(agCur + lA).toFixed(1)}`
        : `${+lH.toFixed(1)} - ${+lA.toFixed(1)}`,
      goalTiming: sim.goalTiming,
      goalMinuteDistribution: goalMinDist.dist,
      goalMinuteSource: goalMinDist.source,
      goalMinuteCount: goalMinDist.goalCount,
      confidence: sim.confidence,
      scenarios:  sim.scenarios,
      modelCalibrated,
      lambdaMultiplier: lambdaMult,
      sampleSize,
      confidenceIntervals: {
        over15: { value: sim.markets.over15, margin: ciMargin },
        over25: { value: sim.markets.over25, margin: ciMargin },
        gg:     { value: sim.markets.gg,     margin: ciMargin },
      },
    },
    factors,
    momentum,
    recommendation: bestBet ? {
      bestBet:    bestBet.name,
      confidence: Math.round(bestBet.prob),
      ev:         `${bestEV >= 0 ? '+' : ''}${(bestEV * 100).toFixed(1)}%`,
      cota:       bestBet.cota,
      reasoning:  `λ ${+lH.toFixed(2)}+${+lA.toFixed(2)}=${+(lH+lA).toFixed(2)}, Elo ${elo.eloDiff>0?'+':''}${elo.eloDiff}, referee: ${refStats?.style||'unknown'}, ${dqLevel} quality`,
    } : null,
  };

  evictSimCache();
  cache.set(ck, { data: result, ts: Date.now() });
  return res.status(200).json(result);
}
