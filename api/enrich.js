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

  const homeAvgScored   = avg(hGames, m => m.goals?.home ?? 0);
  const homeAvgConceded = avg(hGames, m => m.goals?.away ?? 0);
  const awayAvgScored   = avg(aGames, m => m.goals?.away ?? 0);
  const awayAvgConceded = avg(aGames, m => m.goals?.home ?? 0);

  let lambdaHome  = (homeAvgScored + awayAvgConceded) / 2;
  let lambdaAway  = (awayAvgScored + homeAvgConceded) / 2;

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
      fetch(`${sbUrl}/rest/v1/player_stats?team_id=eq.${hId}&select=rating,goals,pass_accuracy,shots_on_target&order=recorded_at.desc&limit=110`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      }),
      fetch(`${sbUrl}/rest/v1/player_stats?team_id=eq.${aId}&select=rating,goals,pass_accuracy,shots_on_target&order=recorded_at.desc&limit=110`, {
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
  // STRAT 1 — Poisson (20%)
  const score1 = result.over15Prob ?? 50;

  // STRAT 2 — Forma recentă (18%)
  const homeAvg = result.homeAvgScored ?? 1.2;
  const awayAvg = result.awayAvgScored ?? 1.0;
  const score2 = Math.min(100, (homeAvg + awayAvg) / 3.5 * 100);

  // STRAT 3 — H2H (13%)
  const score3 = result.h2hOver15 != null ? result.h2hOver15 : score1;

  // STRAT 4 — Live/fallback (13%)
  let score4 = score1;
  if (liveStats && liveStats.xg != null) {
    score4 = Math.min(100, liveStats.xg * 25 + (liveStats.sot || 0) * 3 + (liveStats.da || 0) * 0.5);
  }

  // STRAT 5 — EV pe piața 1.30-1.50 (13%)
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

  // STRAT 6 — Consistență (8%)
  const scores = [score1, score2, score3, score4, score5];
  const alignedCount = scores.filter(s => s > 60).length;
  const score6 = (alignedCount / 5) * 100;

  // STRAT 7 — Puterea echipei din player_stats (15%)
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
    const [r1, r2, r3, r4] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/fixtures?team=${h}&last=20&status=FT`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures?team=${a}&last=20&status=FT`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${h}-${a}&last=10`, { headers: hdr }),
      fid ? fetch(`https://v3.football.api-sports.io/odds?fixture=${fid}&bookmaker=8`, { headers: hdr })
          : Promise.resolve(null),
    ]);

    const [[d1, d2, d3], teamStrengths] = await Promise.all([
      Promise.all([r1.json(), r2.json(), r3.json()]),
      getTeamStrengths(hId, aId, sbUrl, sbKey),
    ]);

    const hGames = (d1.response || []).filter(m => m.teams?.home?.id === hId).slice(0, 10);
    const aGames = (d2.response || []).filter(m => m.teams?.away?.id === aId).slice(0, 10);
    const h2h    = (d3.response || []).slice(0, 10);

    // Parse odds; fallback to league-wide odds if fixture returns nothing
    let oddsRaw = null;
    if (r4) {
      const d4 = await r4.json();
      const item = (d4.response || [])[0];
      if (item) oddsRaw = parseOddsItem(item);

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

    const result   = calcPoisson(hGames, aGames, h2h, hId, aId, elapsed, hg, ag, soth, sota);
    const evData   = calcEV(result, oddsRaw, bankroll);

    const liveStats = (elapsed && parseInt(elapsed) > 0) ? {
      xg:  (parseFloat(soth) || 0) * 0.4 + (parseFloat(sota) || 0) * 0.4,
      sot: (parseInt(soth) || 0) + (parseInt(sota) || 0),
      da:  0,
    } : null;

    const confData = calcConfidence(result, oddsRaw, liveStats, teamStrengths);

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
