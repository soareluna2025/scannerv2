function poissonProb(lambda, k) {
  let result = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) result *= lambda / i;
  return result;
}

function calcPoisson6x6(lambdaHome, lambdaAway) {
  let probHomeWin = 0, probDraw = 0, probAwayWin = 0;
  let probOver15 = 0, probOver25 = 0, probGG = 0;

  for (let i = 0; i <= 5; i++) {
    for (let j = 0; j <= 5; j++) {
      const p = poissonProb(lambdaHome, i) * poissonProb(lambdaAway, j);
      if (i > j) probHomeWin += p;
      else if (i === j) probDraw += p;
      else probAwayWin += p;
      if (i + j >= 2) probOver15 += p;
      if (i + j >= 3) probOver25 += p;
      if (i > 0 && j > 0) probGG += p;
    }
  }

  const total = probHomeWin + probDraw + probAwayWin;
  return {
    homeWin:    Math.round(probHomeWin / total * 100),
    draw:       Math.round(probDraw    / total * 100),
    awayWin:    Math.round(probAwayWin / total * 100),
    over15Prob: Math.round(probOver15 * 100),
    over25Prob: Math.round(probOver25 * 100),
    ggProb:     Math.round(probGG     * 100)
  };
}

function parseOddsItem(item) {
  const bookmaker = (item.bookmakers || [])[0];
  if (!bookmaker) return null;
  const getBet = name => (bookmaker.bets || []).find(b => b.name === name);
  const getOdd = (bet, value) => {
    if (!bet) return null;
    const v = (bet.values || []).find(x => x.value === value);
    return v ? parseFloat(v.odd) : null;
  };
  const mw  = getBet('Match Winner');
  const gou = getBet('Goals Over/Under');
  const bts = getBet('Both Teams Score');
  const result = {
    cotaHome:   getOdd(mw, 'Home'),
    cotaDraw:   getOdd(mw, 'Draw'),
    cotaAway:   getOdd(mw, 'Away'),
    cotaOver15: getOdd(gou, 'Over 1.5'),
    cotaGG:     getOdd(bts, 'Yes'),
  };
  return (result.cotaHome || result.cotaOver15) ? result : null;
}

function calcEV(matrix, oddsRaw, bankroll) {
  const ev = { hasOdds: false };
  if (!oddsRaw) return ev;

  const { cotaHome, cotaDraw, cotaAway, cotaOver15, cotaGG } = oddsRaw;
  if (!cotaHome || !cotaDraw || !cotaAway) return ev;

  ev.hasOdds   = true;
  ev.cotaHome   = cotaHome;
  ev.cotaDraw   = cotaDraw;
  ev.cotaAway   = cotaAway;
  ev.cotaOver15 = cotaOver15 || null;
  ev.cotaGG     = cotaGG || null;

  const impliedHome  = 1 / cotaHome;
  const impliedDraw  = 1 / cotaDraw;
  const impliedAway  = 1 / cotaAway;
  const totalImplied = impliedHome + impliedDraw + impliedAway;

  ev.evHome  = (matrix.homeWin / 100) - (impliedHome  / totalImplied);
  ev.evDraw  = (matrix.draw    / 100) - (impliedDraw  / totalImplied);
  ev.evAway  = (matrix.awayWin / 100) - (impliedAway  / totalImplied);

  if (cotaOver15) ev.evOver15 = (matrix.over15Prob / 100) - (1 / cotaOver15);
  if (cotaGG)     ev.evGG     = (matrix.ggProb     / 100) - (1 / cotaGG);

  function kelly(edge, br) {
    if (edge == null || edge < 0.04) return 0;
    return Math.min(br * edge * 0.5, br * 0.04);
  }
  ev.kellyOver15 = kelly(ev.evOver15, bankroll);
  ev.kellyGG     = kelly(ev.evGG, bankroll);

  const candidates = [
    { name: 'Over 1.5',    ev: ev.evOver15, cota: cotaOver15 },
    { name: 'GG',          ev: ev.evGG,     cota: cotaGG     },
    { name: '1 (Gazde)',   ev: ev.evHome,   cota: cotaHome   },
    { name: 'X (Egal)',    ev: ev.evDraw,   cota: cotaDraw   },
    { name: '2 (Oaspeti)', ev: ev.evAway,   cota: cotaAway   },
  ].filter(c => c.ev != null && c.ev > 0).sort((a, b) => b.ev - a.ev);

  if (candidates.length) {
    ev.bestBet   = candidates[0].name;
    ev.bestEV    = candidates[0].ev;
    ev.bestCota  = candidates[0].cota;
    ev.bestKelly = kelly(candidates[0].ev, bankroll);
  }

  const r3 = v => v != null ? Math.round(v * 1000) / 1000 : null;
  const r2 = v => v != null ? Math.round(v * 100)  / 100  : null;
  ev.evHome      = r3(ev.evHome);
  ev.evDraw      = r3(ev.evDraw);
  ev.evAway      = r3(ev.evAway);
  ev.evOver15    = r3(ev.evOver15);
  ev.evGG        = r3(ev.evGG);
  ev.bestEV      = r3(ev.bestEV);
  ev.kellyOver15 = r2(ev.kellyOver15);
  ev.kellyGG     = r2(ev.kellyGG);
  ev.bestKelly   = r2(ev.bestKelly);

  return ev;
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
    homeScoreRate:   pct(hGames, m => (m.goals?.home ?? 0) > 0),
    awayAvgScored:   r2(awayAvgScored),
    awayAvgConceded: r2(awayAvgConceded),
    awayScoreRate:   pct(aGames, m => (m.goals?.away ?? 0) > 0),
    lambdaHome:      r2(lambdaHome),
    lambdaAway:      r2(lambdaAway),
    lambdaTotal:     r2(lambdaTotal),
    over15Prob:      matrix.over15Prob,
    over25Prob:      matrix.over25Prob,
    ggProb:          matrix.ggProb,
    homeWin:         matrix.homeWin,
    draw:            matrix.draw,
    awayWin:         matrix.awayWin,
    h2hOver15:       pct(h2h, m => ((m.goals?.home ?? 0) + (m.goals?.away ?? 0)) > 1),
    h2hGG:           pct(h2h, m => (m.goals?.home ?? 0) > 0 && (m.goals?.away ?? 0) > 0),
    h2hSample:       h2h.length,
    confidence,
    isDynamic
  };
}

async function getTeamStrengths(hId, aId, sbUrl, sbKey) {
  if (!sbUrl || !sbKey) return { home: null, away: null };
  try {
    const [rH, rA] = await Promise.all([
      fetch(`${sbUrl}/rest/v1/player_stats?team_id=eq.${hId}&select=rating,goals,pass_accuracy,shots_on_target&order=player_id.desc&limit=110`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      }),
      fetch(`${sbUrl}/rest/v1/player_stats?team_id=eq.${aId}&select=rating,goals,pass_accuracy,shots_on_target&order=player_id.desc&limit=110`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      }),
    ]);
    const [dH, dA] = await Promise.all([rH.json(), rA.json()]);

    const calcStr = (rows) => {
      if (!Array.isArray(rows) || !rows.length) return null;
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

  const homeAvg = result.homeAvgScored ?? 1.2;
  const awayAvg = result.awayAvgScored ?? 1.0;
  const score2 = Math.min(100, (homeAvg + awayAvg) / 3.5 * 100);

  const score3 = result.h2hOver15 != null ? result.h2hOver15 : score1;

  let score4 = score1;
  if (liveStats && liveStats.xg != null) {
    score4 = Math.min(100, liveStats.xg * 25 + (liveStats.sot || 0) * 3 + (liveStats.da || 0) * 0.5);
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
        score5 = 20;
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
    const h = teamStrengths.home ?? 50;
    const a = teamStrengths.away ?? 50;
    score7 = Math.round((h + a) / 2);
  }

  const hasStr = score7 != null;
  const confidenceScore = hasStr
    ? Math.round(score1 * 0.20 + score2 * 0.18 + score3 * 0.13 + score4 * 0.13 + score5 * 0.13 + score6 * 0.08 + score7 * 0.15)
    : Math.round(score1 * 0.25 + score2 * 0.20 + score3 * 0.15 + score4 * 0.15 + score5 * 0.15 + score6 * 0.10);

  return {
    confidenceScore,
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

// --- Supabase data helpers ---

async function getFormFromSupabase(teamId, sbUrl, sbKey) {
  try {
    const res = await fetch(
      `${sbUrl}/rest/v1/form_stats?team_id=eq.${teamId}&order=match_date.desc&limit=10`,
      { headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` } }
    );
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (_) { return []; }
}

async function getH2HFromSupabase(homeId, awayId, sbUrl, sbKey) {
  try {
    const res = await fetch(
      `${sbUrl}/rest/v1/h2h` +
      `?or=(and(home_team_id.eq.${homeId},away_team_id.eq.${awayId}),` +
      `and(home_team_id.eq.${awayId},away_team_id.eq.${homeId}))` +
      `&order=match_date.desc&limit=10`,
      { headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` } }
    );
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (_) { return []; }
}

async function getOddsFromSupabase(fixtureId, sbUrl, sbKey) {
  try {
    const res = await fetch(
      `${sbUrl}/rest/v1/odds?fixture_id=eq.${fixtureId}&bookmaker_id=eq.8`,
      { headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` } }
    );
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (_) { return []; }
}

async function getInjuriesFromSupabase(fixtureId, sbUrl, sbKey) {
  try {
    const url = `${sbUrl}/rest/v1/injuries?fixture_id=eq.${fixtureId}&active=eq.true`;
    const res = await fetch(url, {
      headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
    });
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (_) { return []; }
}

async function getMatchStatsFromSupabase(fixtureId, sbUrl, sbKey) {
  if (!fixtureId) return [];
  try {
    const url = `${sbUrl}/rest/v1/match_stats?fixture_id=eq.${fixtureId}`;
    const res = await fetch(url, {
      headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
    });
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (_) { return []; }
}

async function getLeaguePatternFromSupabase(leagueId, sbUrl, sbKey) {
  if (!leagueId) return null;
  try {
    const url = `${sbUrl}/rest/v1/league_patterns?league_id=eq.${leagueId}&limit=1`;
    const res = await fetch(url, {
      headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
    });
    const data = await res.json();
    return data?.[0] || null;
  } catch (_) { return null; }
}

// Transform form_stats rows → API-Football-like format expected by calcPoisson
function formStatsToFixtures(rows, teamId) {
  return rows.map(row => ({
    teams: {
      home: { id: row.is_home ? teamId : 0 },
      away: { id: row.is_home ? 0 : teamId },
    },
    goals: {
      home: row.is_home ? (row.goals_scored ?? 0) : (row.goals_conceded ?? 0),
      away: row.is_home ? (row.goals_conceded ?? 0) : (row.goals_scored ?? 0),
    },
  }));
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
  const sbUrl    = process.env.SUPABASE_URL;
  const sbKey    = process.env.SUPABASE_KEY;

  try {
    // --- Batch 1: Supabase queries + team strengths + injuries + match_stats + league_pattern in parallel ---
    const [sbHForm, sbAForm, sbH2H, sbOddsRows, teamStrengths, injuries, matchStats, leaguePattern] = await Promise.all([
      sbUrl && sbKey ? getFormFromSupabase(hId, sbUrl, sbKey)              : Promise.resolve([]),
      sbUrl && sbKey ? getFormFromSupabase(aId, sbUrl, sbKey)              : Promise.resolve([]),
      sbUrl && sbKey ? getH2HFromSupabase(hId, aId, sbUrl, sbKey)         : Promise.resolve([]),
      fid && sbUrl && sbKey ? getOddsFromSupabase(Number(fid), sbUrl, sbKey) : Promise.resolve([]),
      getTeamStrengths(hId, aId, sbUrl, sbKey),
      fid && sbUrl && sbKey ? getInjuriesFromSupabase(Number(fid), sbUrl, sbKey) : Promise.resolve([]),
      fid && sbUrl && sbKey ? getMatchStatsFromSupabase(Number(fid), sbUrl, sbKey) : Promise.resolve([]),
      lgid && sbUrl && sbKey ? getLeaguePatternFromSupabase(Number(lgid), sbUrl, sbKey) : Promise.resolve(null),
    ]);

    // --- Batch 2: API-Football fallbacks only where Supabase had insufficient data ---
    const needHForm = sbHForm.length  < 3;
    const needAForm = sbAForm.length  < 3;
    const needH2H   = sbH2H.length    < 3;
    const needOdds  = fid && sbOddsRows.length === 0;

    const [apiFbHForm, apiFbAForm, apiFbH2H, apiFbOdds] = await Promise.all([
      needHForm ? fetch(`https://v3.football.api-sports.io/fixtures?team=${h}&last=20&status=FT`, { headers: hdr }).then(r => r.json()) : null,
      needAForm ? fetch(`https://v3.football.api-sports.io/fixtures?team=${a}&last=20&status=FT`, { headers: hdr }).then(r => r.json()) : null,
      needH2H   ? fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${h}-${a}&last=10`, { headers: hdr }).then(r => r.json()) : null,
      needOdds  ? fetch(`https://v3.football.api-sports.io/odds?fixture=${fid}&bookmaker=8`, { headers: hdr }).then(r => r.json()) : null,
    ]);

    // Resolve final datasets
    const hGames = needHForm
      ? (apiFbHForm?.response || []).slice(0, 10)
      : formStatsToFixtures(sbHForm, hId);

    const aGames = needAForm
      ? (apiFbAForm?.response || []).slice(0, 10)
      : formStatsToFixtures(sbAForm, aId);

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
            `https://v3.football.api-sports.io/odds?league=${lgid}&season=${new Date().getFullYear()}&bookmaker=8`,
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

    // --- Resolve xG: real from match_stats if available, else estimate from shots ---
    let xgSource = 'estimated';
    let xgValue  = (parseFloat(soth) || 0) * 0.4 + (parseFloat(sota) || 0) * 0.4;

    if (Array.isArray(matchStats) && matchStats.length) {
      // Flat schema: single row with home_xg / away_xg columns
      if (matchStats[0].home_xg != null || matchStats[0].away_xg != null) {
        xgValue  = (parseFloat(matchStats[0].home_xg) || 0) + (parseFloat(matchStats[0].away_xg) || 0);
        xgSource = 'supabase';
      } else {
        // Per-team rows with an xg column
        const homeRow = matchStats.find(r => r.team_id === hId && r.xg != null);
        const awayRow = matchStats.find(r => r.team_id === aId && r.xg != null);
        if (homeRow || awayRow) {
          xgValue  = (parseFloat(homeRow?.xg) || 0) + (parseFloat(awayRow?.xg) || 0);
          xgSource = 'supabase';
        }
      }
    }

    const liveStats = (elapsed && parseInt(elapsed) > 0) ? {
      xg:  xgValue,
      sot: (parseInt(soth) || 0) + (parseInt(sota) || 0),
      da:  0,
    } : null;

    const confData = calcConfidence(result, oddsRaw, liveStats, teamStrengths);

    // Add xg_source flag to breakdown when in live mode
    if (elapsed && parseInt(elapsed) > 0) {
      confData.breakdown.xg_source = xgSource;
    }

    // --- Injuries adjustment (only when fid is present) ---
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

    // --- League pattern adjustment (only when lgid present and pattern found) ---
    if (leaguePattern) {
      const avgOver15 = parseFloat(leaguePattern.avg_over15) || 0;
      const avgGG     = parseFloat(leaguePattern.avg_gg)     || 0;
      let leagueAdj = 0;

      if (avgOver15 > 0.65)      leagueAdj += 3;
      else if (avgOver15 < 0.45) leagueAdj -= 3;

      if (avgGG > 0.60) leagueAdj += 2;

      if (leagueAdj !== 0) {
        confData.confidenceScore = Math.max(10, confData.confidenceScore + leagueAdj);
        confData.breakdown.league_pattern = {
          layer: 'league_pattern',
          value: leagueAdj,
          note:  `avg_over15: ${Math.round(avgOver15 * 100)}%`,
        };
      }
    }

    const payload = { ...result, ...evData, ...confData };

    if (sbUrl && sbKey && fid) {
      fetch(`${sbUrl}/rest/v1/predictions`, {
        method: 'POST',
        headers: {
          'apikey':        sbKey,
          'Authorization': `Bearer ${sbKey}`,
          'Content-Type':  'application/json',
          'Prefer':        'resolution=ignore-duplicates,return=minimal'
        },
        body: JSON.stringify({
          fixture_id:      Number(fid),
          home_team:       hn  || '',
          away_team:       an  || '',
          league_name:     lg  || '',
          league_id:       lgid ? Number(lgid) : null,
          match_date:      dt  || null,
          lambda_home:     payload.lambdaHome,
          lambda_away:     payload.lambdaAway,
          lambda_total:    payload.lambdaTotal,
          over15_prob:     payload.over15Prob,
          over25_prob:     payload.over25Prob,
          gg_prob:         payload.ggProb,
          home_score_rate: payload.homeScoreRate,
          away_score_rate: payload.awayScoreRate,
          h2h_over15:      payload.h2hOver15,
          confidence:      payload.confidence,
        })
      }).catch(() => {});
    }

    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
