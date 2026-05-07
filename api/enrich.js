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

function calcPoisson(hGames, aGames, h2h, hId, aId, elapsedParam, hgParam, agParam, xghParam, xgaParam, sothParam, sotaParam) {
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
    const dynAway = calcDynamicLambda(lambdaAway, elapsedNum, parseInt(agParam) || 0, parseInt(sotaParam) || 0);
    lambdaHome = dynHome.lambda;
    lambdaAway = dynAway.lambda;
    isDynamic = dynHome.dynamic || dynAway.dynamic;
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  const { h, a, fid, hn, an, lg, lgid, dt, br, elapsed, hg, ag, xgh, xga, soth, sota } = req.query;
  if (!h || !a) return res.status(400).json({ error: 'Parametri h si a sunt necesari' });

  const hId      = Number(h);
  const aId      = Number(a);
  const bankroll = parseFloat(br) || 10;
  const hdr      = { 'x-apisports-key': key };

  try {
    const [r1, r2, r3, r4, r5, r6] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/fixtures?team=${h}&last=20&status=FT`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures?team=${a}&last=20&status=FT`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${h}-${a}&last=10`, { headers: hdr }),
      fid ? fetch(`https://v3.football.api-sports.io/odds?fixture=${fid}&bookmaker=8`, { headers: hdr })
          : Promise.resolve(null),
      fetch(`https://v3.football.api-sports.io/fixtures?team=${h}&next=5`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures?team=${a}&next=5`, { headers: hdr }),
    ]);

    const [d1, d2, d3, d5raw, d6raw] = await Promise.all([r1.json(), r2.json(), r3.json(), r5.json(), r6.json()]);

    const hGames = (d1.response || []).filter(m => m.teams?.home?.id === hId).slice(0, 10);
    const aGames = (d2.response || []).filter(m => m.teams?.away?.id === aId).slice(0, 10);
    const h2h    = (d3.response || []).slice(0, 10);

    // Next fixtures
    const nextFixtures_home = (d5raw.response || []).map(fx => ({
      date:        fx.fixture?.date ? fx.fixture.date.substring(0, 10) : '',
      opponent:    fx.teams?.home?.id === hId ? fx.teams?.away?.name : fx.teams?.home?.name,
      isHome:      fx.teams?.home?.id === hId,
      competition: fx.league?.name || '',
    }));
    const nextFixtures_away = (d6raw.response || []).map(fx => ({
      date:        fx.fixture?.date ? fx.fixture.date.substring(0, 10) : '',
      opponent:    fx.teams?.home?.id === aId ? fx.teams?.away?.name : fx.teams?.home?.name,
      isHome:      fx.teams?.home?.id === aId,
      competition: fx.league?.name || '',
    }));

    // Parse odds; fallback to league-wide odds if fixture returns nothing
    let oddsRaw = null;
    if (r4) {
      const d4 = await r4.json();
      const item = (d4.response || [])[0];
      if (item) oddsRaw = parseOddsItem(item);

      if (!oddsRaw && lgid) {
        try {
          const rOdds = await fetch(
            `https://v3.football.api-sports.io/odds?league=${lgid}&season=${new Date().getFullYear()}&bookmaker=8`,
            { headers: hdr }
          );
          const dOdds = await rOdds.json();
          const item2 = (dOdds.response || []).find(x => x.fixture?.id === Number(fid));
          if (item2) oddsRaw = parseOddsItem(item2);
        } catch (_) { /* odds unavailable */ }
      }
    }

    const result  = calcPoisson(hGames, aGames, h2h, hId, aId, elapsed, hg, ag, xgh, xga, soth, sota);
    const evData  = calcEV(result, oddsRaw, bankroll);

    // 50/25/25 weighting
    const h2hOver15W = result.h2hOver15 != null ? result.h2hOver15 / 100 : result.over15Prob / 100;
    const h2hGGW     = result.h2hGG     != null ? result.h2hGG     / 100 : result.ggProb     / 100;

    let liveOver15W = result.over15Prob / 100;
    let liveGGW     = result.ggProb     / 100;
    const elapsedNum = parseInt(elapsed) || 0;
    if (elapsedNum > 0 && (parseFloat(xgh) || 0) + (parseFloat(xga) || 0) > 0) {
      const totalXg  = (parseFloat(xgh) || 0) + (parseFloat(xga) || 0);
      const totalSot = (parseInt(soth)  || 0) + (parseInt(sota)  || 0);
      const shotRate = totalSot / Math.max(elapsedNum, 1) * 90;
      liveOver15W = totalXg > 2.0 ? 0.88 : totalXg > 1.2 ? 0.75 : totalXg > 0.6 ? 0.62 : 0.45;
      liveOver15W += shotRate > 8 ? 0.05 : shotRate < 3 ? -0.05 : 0;
      liveOver15W = Math.max(0.05, Math.min(0.97, liveOver15W));
      liveGGW = totalXg > 1.5 ? 0.80 : totalXg > 0.8 ? 0.65 : 0.45;
    }

    let weightForm, weightH2H, weightLive;
    if (elapsedNum > 0) {
      weightForm = 0.50; weightH2H = 0.25; weightLive = 0.25;
    } else {
      weightForm = 0.67; weightH2H = 0.33; weightLive = 0;
    }

    const blendedOver15 = Math.round((weightForm * result.over15Prob / 100 + weightH2H * h2hOver15W + weightLive * liveOver15W) * 100);
    const blendedGG     = Math.round((weightForm * result.ggProb     / 100 + weightH2H * h2hGGW     + weightLive * liveGGW)     * 100);

    const payload = {
      ...result,
      ...evData,
      weightForm,
      weightH2H,
      weightLive,
      blendedOver15,
      blendedGG,
      nextFixtures_home,
      nextFixtures_away,
    };

    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_KEY;
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
