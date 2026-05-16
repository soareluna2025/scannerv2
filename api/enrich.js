import { calcPoisson6x6, parseOddsItem, calcEV } from './calc-utils.js';
import { query } from './db.js';

async function fetchWithRetry(url, opts, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    try { return await fetch(url, opts); } catch (e) {
      if (i === attempts - 1) throw e;
    }
  }
}

function calcDynamicLambda(lambdaBase, elapsed, currentGoals, sot) {
  if (!elapsed || elapsed <= 0) return { lambda: lambdaBase, dynamic: false };
  const minutesLeft = Math.max(1, 90 - elapsed);
  const fraction = minutesLeft / 90;
  const shotRate = (sot / Math.max(elapsed, 1)) * 90;
  const intensityFactor = 1 + Math.min(shotRate / 25, 0.4);
  const lambdaRemaining = lambdaBase * fraction * intensityFactor;
  return { lambda: currentGoals + lambdaRemaining, dynamic: true };
}

function calcPoisson(hGames, aGames, h2h, hId, aId, elapsedParam, hgParam, agParam, sothParam, sotaParam) {
  const avg = (arr, fn) => arr.length ? arr.reduce((s, m) => s + fn(m), 0) / arr.length : 0;
  const pct = (arr, fn) => arr.length ? Math.round(arr.filter(fn).length / arr.length * 100) : null;

  const homeAvgScored   = avg(hGames, m => (m.teams?.home?.id === hId ? m.goals?.home : m.goals?.away) ?? 0);
  const homeAvgConceded = avg(hGames, m => (m.teams?.home?.id === hId ? m.goals?.away : m.goals?.home) ?? 0);
  const awayAvgScored   = avg(aGames, m => (m.teams?.away?.id === aId ? m.goals?.away : m.goals?.home) ?? 0);
  const awayAvgConceded = avg(aGames, m => (m.teams?.away?.id === aId ? m.goals?.home : m.goals?.away) ?? 0);

  const FALLBACK = 1.2;
  let lambdaHome = hGames.length && aGames.length
    ? (homeAvgScored + awayAvgConceded) / 2
    : FALLBACK;
  let lambdaAway = hGames.length && aGames.length
    ? (awayAvgScored + homeAvgConceded) / 2
    : FALLBACK;

  let isDynamic = false;
  const elapsedNum = parseInt(elapsedParam) || 0;
  if (elapsedNum > 0) {
    const dynHome = calcDynamicLambda(lambdaHome, elapsedNum, parseInt(hgParam) || 0, parseInt(sothParam) || 0);
    const dynAway = calcDynamicLambda(lambdaAway, elapsedNum, parseInt(agParam)  || 0, parseInt(sotaParam) || 0);
    lambdaHome = dynHome.lambda;
    lambdaAway = dynAway.lambda;
    isDynamic  = dynHome.dynamic || dynAway.dynamic;
  }

  const lambdaTotal = lambdaHome + lambdaAway;
  const matrix = calcPoisson6x6(lambdaHome, lambdaAway);

  const confidence = (h2h.length >= 8 && hGames.length >= 8 && aGames.length >= 8) ? 'HIGH'
                   : (h2h.length >= 5 && hGames.length >= 5 && aGames.length >= 5) ? 'MED'
                   : 'LOW';

  const r2 = v => Math.round(v * 100) / 100;

  return {
    homeAvgScored:   r2(homeAvgScored),
    homeAvgConceded: r2(homeAvgConceded),
    homeScoreRate:   pct(hGames, m => ((m.teams?.home?.id === hId ? m.goals?.home : m.goals?.away) ?? 0) > 0) ?? Math.round((1 - Math.exp(-lambdaHome)) * 100),
    awayAvgScored:   r2(awayAvgScored),
    awayAvgConceded: r2(awayAvgConceded),
    awayScoreRate:   pct(aGames, m => ((m.teams?.away?.id === aId ? m.goals?.away : m.goals?.home) ?? 0) > 0) ?? Math.round((1 - Math.exp(-lambdaAway)) * 100),
    lambdaHome:      r2(lambdaHome),
    lambdaAway:      r2(lambdaAway),
    lambdaTotal:     r2(lambdaTotal),
    over15Prob:      matrix.over15Prob,
    over25Prob:      matrix.over25Prob,
    ggProb:          matrix.ggProb,
    homeWin:         matrix.homeWin,
    draw:            matrix.draw,
    awayWin:         matrix.awayWin,
    h2hOver15:       pct(h2h, m => ((m.goals?.home ?? 0) + (m.goals?.away ?? 0)) > 1) ?? matrix.over15Prob,
    h2hGG:           pct(h2h, m => (m.goals?.home ?? 0) > 0 && (m.goals?.away ?? 0) > 0) ?? matrix.ggProb,
    h2hSample:       h2h.length,
    confidence,
    isDynamic
  };
}

async function getTeamStrengths(hId, aId) {
  try {
    const [rH, rA] = await Promise.all([
      query('SELECT rating, goals, pass_accuracy, shots_on_target FROM player_stats WHERE team_id = $1 ORDER BY fixture_id DESC LIMIT 110', [hId]),
      query('SELECT rating, goals, pass_accuracy, shots_on_target FROM player_stats WHERE team_id = $1 ORDER BY fixture_id DESC LIMIT 110', [aId]),
    ]);
    const dH = rH.rows;
    const dA = rA.rows;

    const calcStr = (rows) => {
      if (!Array.isArray(rows) || rows.length < 10) return null;
      const rated     = rows.filter(r => r.rating);
      const avgRating = rated.length ? rated.reduce((s, r) => s + Number(r.rating), 0) / rated.length : 5;
      const goalsPerGame = rows.reduce((s, r) => s + (r.goals || 0), 0) / rows.length;
      const withPass     = rows.filter(r => r.pass_accuracy != null);
      const avgPassAcc   = withPass.length ? withPass.reduce((s, r) => s + Number(r.pass_accuracy), 0) / withPass.length : 50;
      const avgSot       = rows.reduce((s, r) => s + (r.shots_on_target || 0), 0) / rows.length;
      const topScorer    = Math.max(...rows.map(r => r.goals || 0), 0);
      const topScorerForm = Math.min(100, topScorer * 20);
      return Math.round(
        (avgRating / 10 * 100) * 0.35 +
        Math.min(100, goalsPerGame * 35) * 0.25 +
        avgPassAcc * 0.20 +
        Math.min(100, avgSot * 12) * 0.10 +
        topScorerForm * 0.10
      );
    };

    return { home: calcStr(dH), away: calcStr(dA) };
  } catch (_) {
    return { home: null, away: null };
  }
}

function calcConfidence(result, oddsRaw, liveStats, teamStrengths) {
  const score1 = result.over15Prob ?? 50;
  const elapsed = liveStats?.elapsed ?? 0;
  const sotTotal = liveStats?.sot ?? null;
  const ycTotal  = liveStats?.yc  ?? 0;

  const homeAvg = result.homeAvgScored ?? 1.2;
  const awayAvg = result.awayAvgScored ?? 1.0;
  const score2 = Math.min(100, (homeAvg + awayAvg) / 3.5 * 100);

  const score3 = result.h2hOver15 != null ? result.h2hOver15 : score1;

  let score4 = score1;
  if (liveStats && liveStats.xg != null) {
    score4 = Math.max(50, Math.min(100, liveStats.xg * 25 + (liveStats.sot || 0) * 3 + (liveStats.da || 0) * 0.5));
  }

  let score5 = 50;
  let bestMarket = null, bestCota = null, bestEV = null;
  if (oddsRaw) {
    const markets = [
      { name: 'Over 1.5', cota: oddsRaw.cotaOver15, prob: result.over15Prob / 100 },
      { name: 'GG',       cota: oddsRaw.cotaGG,     prob: result.ggProb     / 100 },
      { name: '1 Gazde',  cota: oddsRaw.cotaHome,   prob: result.homeWin    / 100 },
      { name: 'X Egal',   cota: oddsRaw.cotaDraw,   prob: result.draw       / 100 },
      { name: '2 Oasp.',  cota: oddsRaw.cotaAway,   prob: result.awayWin    / 100 },
    ].filter(m => m.cota >= 1.30 && m.cota <= 1.50 && m.prob != null);

    if (markets.length) {
      const evMarkets = markets.map(m => ({ ...m, ev: m.prob * m.cota - 1 }))
        .sort((a, b) => b.ev - a.ev);
      const best = evMarkets[0];
      if (best.ev > 0) {
        score5 = Math.min(100, best.ev * 300);
        bestMarket = best.name;
        bestCota   = best.cota;
        bestEV     = '+' + Math.round(best.ev * 100) + '%';
      } else {
        score5 = 50;
      }
    }
  }

  const scores = [score1, score2, score3, score4, score5];
  const alignedCount = scores.filter(s => s > 60).length;
  const score6 = (alignedCount / 5) * 100;

  let score7 = null;
  let teamStrengthHome = null, teamStrengthAway = null;
  if (teamStrengths && (teamStrengths.home != null || teamStrengths.away != null)) {
    teamStrengthHome = teamStrengths.home;
    teamStrengthAway = teamStrengths.away;
    const h = teamStrengths.home || 50;
    const a = teamStrengths.away || 50;
    score7 = Math.round((h + a) / 2);
  }

  const layers = [
    { score: score1, w: 0.22 },
    { score: score2, w: 0.20 },
    { score: score3, w: 0.10 },
    { score: score4, w: 0.15 },
    { score: score5, w: 0.08 },
    { score: score6, w: 0.05 },
    { score: score7, w: 0.20 },
  ].filter(l => l.score != null);
  const totalW = layers.reduce((s, l) => s + l.w, 0);
  const confidenceScore = Math.round(layers.reduce((s, l) => s + l.score * (l.w / totalW), 0));
  const hasStr = score7 != null;

  let adjustedScore = confidenceScore;
  if (elapsed >= 45 && sotTotal !== null && sotTotal === 0) {
    adjustedScore = Math.max(10, adjustedScore - 20);
  }
  if (ycTotal >= 2) {
    adjustedScore = Math.max(10, adjustedScore - 10);
  }

  return {
    confidenceScore: adjustedScore,
    breakdown: {
      poisson:      Math.round(score1),
      forma:        Math.round(score2),
      h2h:          Math.round(score3),
      live:         Math.round(score4),
      ev:           Math.round(score5),
      consistenta:  Math.round(score6),
      ...(hasStr ? { putereEchipe: score7 } : {}),
    },
    teamStrengthHome,
    teamStrengthAway,
    bestMarket,
    bestCota,
    bestEV,
  };
}

// --- PostgreSQL data helpers ---

async function getFormFromDB(teamId) {
  try {
    const r = await query(
      `SELECT home_team_id, away_team_id, home_goals, away_goals
       FROM fixtures
       WHERE (home_team_id = $1 OR away_team_id = $1)
         AND status_short = 'FT'
         AND home_goals IS NOT NULL
       ORDER BY match_date DESC
       LIMIT 10`,
      [teamId]
    );
    return r.rows.map(row => ({
      teams: { home: { id: row.home_team_id }, away: { id: row.away_team_id } },
      goals: { home: row.home_goals ?? 0, away: row.away_goals ?? 0 },
    }));
  } catch (_) { return []; }
}

async function getH2HFromDB(homeId, awayId) {
  try {
    const r = await query(
      'SELECT * FROM h2h WHERE (home_team_id = $1 AND away_team_id = $2) OR (home_team_id = $2 AND away_team_id = $1) ORDER BY match_date DESC LIMIT 10',
      [homeId, awayId]
    );
    return r.rows;
  } catch (_) { return []; }
}

async function getOddsFromDB(fixtureId) {
  try {
    const r = await query(
      'SELECT *, bet_name AS market, value_name AS label, value_odd AS odd_value FROM odds WHERE fixture_id = $1 AND bookmaker_id = 8',
      [fixtureId]
    );
    return r.rows;
  } catch (_) { return []; }
}

async function getInjuriesFromDB(fixtureId) {
  try {
    const r = await query('SELECT * FROM injuries WHERE fixture_id = $1', [fixtureId]);
    return r.rows;
  } catch (_) { return []; }
}

async function fetchAndStoreInjuries(fixtureId, key) {
  try {
    const r = await fetch(
      `https://v3.football.api-sports.io/injuries?fixture=${fixtureId}`,
      { headers: { 'x-apisports-key': key } }
    );
    const data = await r.json();
    const list = data.response || [];
    for (const item of list) {
      await query(
        `INSERT INTO injuries
           (fixture_id, league_id, season, team_id, team_name,
            player_id, player_name, type, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (fixture_id, player_id) DO NOTHING`,
        [
          fixtureId,
          item.league?.id      || null,
          item.league?.season  || null,
          item.team?.id        || null,
          item.team?.name      || null,
          item.player?.id      || null,
          item.player?.name    || null,
          item.player?.type    || null,
          item.player?.reason  || null,
        ]
      );
    }
  } catch (_) {}
}

async function getMatchStatsFromDB(fixtureId) {
  if (!fixtureId) return [];
  try {
    const r = await query(
      'SELECT team_id, expected_goals AS xg, shots_on_goal AS shots_on_target FROM match_stats WHERE fixture_id = $1',
      [fixtureId]
    );
    return r.rows;
  } catch (_) { return []; }
}

// Transform h2h rows → API-Football-like format expected by calcPoisson
function h2hToFixtures(rows) {
  return rows.map(row => ({
    goals: { home: row.home_goals ?? 0, away: row.away_goals ?? 0 },
  }));
}

// Transform flat odds rows → parseOddsItem-compatible structure
function oddsRowsToItem(rows) {
  if (!rows.length) return null;
  const betsMap = {};
  for (const row of rows) {
    if (!betsMap[row.market]) betsMap[row.market] = [];
    betsMap[row.market].push({ value: row.label, odd: String(row.odd_value) });
  }
  return {
    bookmakers: [{
      id:   rows[0].bookmaker_id,
      name: rows[0].bookmaker_name,
      bets: Object.entries(betsMap).map(([name, values]) => ({ name, values })),
    }],
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  const { h, a, fid, hn, an, lg, lgid, dt, br, elapsed, hg, ag, soth, sota } = req.query;
  if (!h || !a) return res.status(400).json({ error: 'Parametri h si a sunt necesari' });

  const hId      = Number(h);
  const aId      = Number(a);
  const bankroll = parseFloat(br) || 10;
  const hdr      = { 'x-apisports-key': key };

  try {
    // --- Batch 1: DB queries + team strengths + injuries + match_stats in parallel ---
    const [sbHForm, sbAForm, sbH2H, sbOddsRows, teamStrengths, injuries, matchStats] = await Promise.all([
      getFormFromDB(hId),
      getFormFromDB(aId),
      getH2HFromDB(hId, aId),
      fid ? getOddsFromDB(Number(fid)) : Promise.resolve([]),
      getTeamStrengths(hId, aId),
      fid ? getInjuriesFromDB(Number(fid)) : Promise.resolve([]),
      fid ? getMatchStatsFromDB(Number(fid)) : Promise.resolve([]),
    ]);

    // --- Batch 2: API-Football fallbacks only where DB had insufficient data ---
    const needHForm = sbHForm.length  < 3;
    const needAForm = sbAForm.length  < 3;
    const needH2H   = sbH2H.length    < 3;
    const needOdds  = fid && sbOddsRows.length === 0;

    const [apiFbHForm, apiFbAForm, apiFbH2H, apiFbOdds] = await Promise.all([
      needHForm ? fetchWithRetry(`https://v3.football.api-sports.io/fixtures?team=${h}&last=20&status=FT`, { headers: hdr }).then(r => r.json()) : null,
      needAForm ? fetchWithRetry(`https://v3.football.api-sports.io/fixtures?team=${a}&last=20&status=FT`, { headers: hdr }).then(r => r.json()) : null,
      needH2H   ? fetchWithRetry(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${h}-${a}&last=10`, { headers: hdr }).then(r => r.json()) : null,
      needOdds  ? fetchWithRetry(`https://v3.football.api-sports.io/odds?fixture=${fid}`, { headers: hdr }).then(r => r.json()) : null,
    ]);

    // Resolve final datasets
    const hGames = needHForm ? (apiFbHForm?.response || []).slice(0, 10) : [];
    const aGames = needAForm ? (apiFbAForm?.response || []).slice(0, 10) : [];
    const h2h = needH2H
      ? (apiFbH2H?.response || []).slice(0, 10)
      : h2hToFixtures(sbH2H);

    // Resolve odds
    let oddsRaw = null;
    if (!needOdds && sbOddsRows.length > 0) {
      oddsRaw = parseOddsItem(oddsRowsToItem(sbOddsRows));
    } else if (needOdds && apiFbOdds) {
      const item = (apiFbOdds.response || [])[0];
      if (item) oddsRaw = parseOddsItem(item);

      // League-level fallback
      if (!oddsRaw && lgid) {
        try {
          const r5 = await fetch(
            `https://v3.football.api-sports.io/odds?league=${lgid}&season=${new Date().getFullYear()}`,
            { headers: hdr }
          );
          const d5 = await r5.json();
          const item2 = (d5.response || []).find(x => x.fixture?.id === Number(fid));
          if (item2) oddsRaw = parseOddsItem(item2);
        } catch (_) {}
      }
    }

    // --- Calculations ---
    const result = calcPoisson(hGames, aGames, h2h, hId, aId, elapsed, hg, ag, soth, sota);
    const evData = calcEV(result, oddsRaw, bankroll);

    // --- Resolve xG ---
    let xgSource = 'estimated';
    let xgValue  = (parseFloat(soth) || 0) * 0.4 + (parseFloat(sota) || 0) * 0.4;

    if (Array.isArray(matchStats) && matchStats.length) {
      const homeRow = matchStats.find(r => r.team_id === hId && r.xg != null);
      const awayRow = matchStats.find(r => r.team_id === aId && r.xg != null);
      if (homeRow || awayRow) {
        xgValue  = (parseFloat(homeRow?.xg) || 0) + (parseFloat(awayRow?.xg) || 0);
        xgSource = 'postgres';
      }
    }

    const da  = parseInt(req.query.da)  || 0;
    const yc  = parseInt(req.query.yc)  || 0;
    const elapsedNum = parseInt(elapsed) || 0;
    const liveStats = elapsedNum > 0 ? {
      xg:  xgValue,
      sot: (parseInt(soth) || 0) + (parseInt(sota) || 0),
      da, yc, elapsed: elapsedNum,
    } : null;

    const confData = calcConfidence(result, oddsRaw, liveStats, teamStrengths);

    if (elapsed && parseInt(elapsed) > 0) {
      confData.breakdown.xg_source = xgSource;
    }

    // --- Injuries adjustment ---
    if (fid && Array.isArray(injuries) && injuries.length >= 3) {
      let injuryPenalty = 0;
      if (injuries.length >= 8)      injuryPenalty = 15;
      else if (injuries.length >= 5) injuryPenalty = 10;
      else if (injuries.length >= 3) injuryPenalty = 5;
      confData.confidenceScore = Math.max(10, confData.confidenceScore - injuryPenalty);
      confData.breakdown.injuries = {
        layer: 'injuries',
        value: -injuryPenalty,
        note:  `${injuries.length} jucători accidentați`,
      };
    }

    const payload = { ...result, ...evData, ...confData };

    // Fire-and-forget: colectare injuries + prediction save
    if (fid) {
      fetchAndStoreInjuries(Number(fid), key);
      query(
        `INSERT INTO predictions (fixture_id, home_team, away_team, league_name, league_id, match_date,
          lambda_home, lambda_away, lambda_total, over15_prob, over25_prob, gg_prob,
          home_score_rate, away_score_rate, h2h_over15, confidence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (fixture_id) DO NOTHING`,
        [
          Number(fid), hn || '', an || '', lg || '', lgid ? Number(lgid) : null, dt || null,
          payload.lambdaHome, payload.lambdaAway, payload.lambdaTotal,
          payload.over15Prob, payload.over25Prob, payload.ggProb,
          payload.homeScoreRate, payload.awayScoreRate, payload.h2hOver15,
          payload.confidenceScore || null,
        ]
      ).catch(() => {});
    }

    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
