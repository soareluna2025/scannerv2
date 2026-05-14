function poissonProb(lambda, k) {
  let result = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) result *= lambda / i;
  return result;
}

export function calcPoisson6x6(lambdaHome, lambdaAway) {
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

export function calcEV(matrix, oddsRaw, bankroll) {
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
