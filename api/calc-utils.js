export function calcPlayerScore(rating, goals, assists, passAcc, sot) {
  const ratingNorm = rating ? (rating / 10 * 100) : 50;
  const goalsScore  = Math.min(100, (goals  || 0) * 25);
  const assistScore = Math.min(100, (assists || 0) * 20);
  const passScore   = passAcc != null ? parseFloat(passAcc) : 50;
  const shotScore   = Math.min(100, (sot    || 0) * 15);
  const score = Math.round(ratingNorm * 0.35 + goalsScore * 0.20 + assistScore * 0.15 + passScore * 0.20 + shotScore * 0.10);
  return isNaN(score) ? 0 : score;
}

function poissonProb(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let result = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) result *= lambda / i;
  return result;
}

export function calcPoisson6x6(lambdaHome, lambdaAway) {
  let probHomeWin = 0, probDraw = 0, probAwayWin = 0;
  let probOver05 = 0, probOver15 = 0, probOver25 = 0, probGG = 0;

  for (let i = 0; i <= 5; i++) {
    for (let j = 0; j <= 5; j++) {
      const p = poissonProb(lambdaHome, i) * poissonProb(lambdaAway, j);
      if (i > j) probHomeWin += p;
      else if (i === j) probDraw += p;
      else probAwayWin += p;
      if (i + j >= 1) probOver05 += p;
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
    over05Prob: Math.round(probOver05 * 100),
    over15Prob: Math.round(probOver15 * 100),
    over25Prob: Math.round(probOver25 * 100),
    ggProb:     Math.round(probGG     * 100)
  };
}

// P(X > maxBelow) = P(X >= maxBelow+1) — folosit pentru cartonașe/cornere
// Exemple: poissonProbOver(lambda, 3) = Over 3.5, poissonProbOver(lambda, 8) = Over 8.5
export function poissonProbOver(lambda, maxBelow) {
  if (lambda <= 0) return 0;
  let cdf = 0, term = Math.exp(-lambda);
  cdf += term;
  for (let k = 1; k <= maxBelow; k++) { term *= lambda / k; cdf += term; }
  return Math.max(0, Math.min(100, Math.round((1 - cdf) * 100)));
}

export function parseOddsItem(item) {
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

export function calcEV(matrix, oddsRaw) {
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
  }

  const r3 = v => v != null ? Math.round(v * 1000) / 1000 : null;
  ev.evHome      = r3(ev.evHome);
  ev.evDraw      = r3(ev.evDraw);
  ev.evAway      = r3(ev.evAway);
  ev.evOver15    = r3(ev.evOver15);
  ev.evGG        = r3(ev.evGG);
  ev.bestEV      = r3(ev.bestEV);

  return ev;
}
