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
    ggProb:     Math.round(probGG     * 100),
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
  ev.cotaGG     = cotaGG    || null;

  const impliedHome  = 1 / cotaHome;
  const impliedDraw  = 1 / cotaDraw;
  const impliedAway  = 1 / cotaAway;
  const totalImplied = impliedHome + impliedDraw + impliedAway;

  ev.evHome  = (matrix.homeWin    / 100) - (impliedHome  / totalImplied);
  ev.evDraw  = (matrix.draw       / 100) - (impliedDraw  / totalImplied);
  ev.evAway  = (matrix.awayWin    / 100) - (impliedAway  / totalImplied);
  if (cotaOver15) ev.evOver15 = (matrix.over15Prob / 100) - (1 / cotaOver15);
  if (cotaGG)     ev.evGG     = (matrix.ggProb     / 100) - (1 / cotaGG);

  function kelly(edge, br) {
    if (edge == null || edge < 0.04) return 0;
    return Math.min(br * edge * 0.5, br * 0.04);
  }
  ev.kellyOver15 = kelly(ev.evOver15, bankroll);
  ev.kellyGG     = kelly(ev.evGG,     bankroll);

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
  ev.evHome = r3(ev.evHome); ev.evDraw = r3(ev.evDraw); ev.evAway = r3(ev.evAway);
  ev.evOver15 = r3(ev.evOver15); ev.evGG = r3(ev.evGG); ev.bestEV = r3(ev.bestEV);
  ev.kellyOver15 = r2(ev.kellyOver15); ev.kellyGG = r2(ev.kellyGG); ev.bestKelly = r2(ev.bestKelly);
  return ev;
}

function calcPoisson(hGames, aGames, h2h, hId) {
  const avg = (arr, fn) => arr.length ? arr.reduce((s, m) => s + fn(m), 0) / arr.length : 0;
  const pct = (arr, fn) => arr.length ? Math.round(arr.filter(fn).length / arr.length * 100) : null;
  const r2  = v => Math.round(v * 100) / 100;

  const homeAvgScored   = avg(hGames, m => m.goals?.home ?? 0);
  const homeAvgConceded = avg(hGames, m => m.goals?.away ?? 0);
  const awayAvgScored   = avg(aGames, m => m.goals?.away ?? 0);
  const awayAvgConceded = avg(aGames, m => m.goals?.home ?? 0);
  const lambdaHome  = (homeAvgScored + awayAvgConceded) / 2;
  const lambdaAway  = (awayAvgScored + homeAvgConceded) / 2;
  const lambdaTotal = lambdaHome + lambdaAway;

  const matrix = calcPoisson6x6(lambdaHome, lambdaAway);

  const confidence = (h2h.length >= 8 && hGames.length >= 8 && aGames.length >= 8) ? 'HIGH'
                   : (h2h.length >= 5 && hGames.length >= 5 && aGames.length >= 5) ? 'MED' : 'LOW';

  const formResult = (m, isHome) => {
    const hg = m.goals?.home ?? 0, ag = m.goals?.away ?? 0;
    if (isHome) return hg > ag ? 'W' : hg === ag ? 'D' : 'L';
    return ag > hg ? 'W' : hg === ag ? 'D' : 'L';
  };
  const homeForm = hGames.slice(0, 5).map(m => ({
    result: formResult(m, m.teams?.home?.id === hId),
    score: `${m.goals?.home ?? 0}-${m.goals?.away ?? 0}`,
    opponent: m.teams?.away?.name || '?',
    date: m.fixture?.date?.slice(0, 10) || ''
  }));
  const awayForm = aGames.slice(0, 5).map(m => ({
    result: formResult(m, false),
    score: `${m.goals?.home ?? 0}-${m.goals?.away ?? 0}`,
    opponent: m.teams?.home?.name || '?',
    date: m.fixture?.date?.slice(0, 10) || ''
  }));
  const h2hForm = h2h.slice(0, 5).map(m => ({
    home: m.teams?.home?.name || '?',
    away: m.teams?.away?.name || '?',
    score: `${m.goals?.home ?? 0}-${m.goals?.away ?? 0}`,
    date: m.fixture?.date?.slice(0, 10) || ''
  }));

  return {
    homeAvgScored: r2(homeAvgScored), homeAvgConceded: r2(homeAvgConceded),
    homeScoreRate: pct(hGames, m => (m.goals?.home ?? 0) > 0),
    awayAvgScored: r2(awayAvgScored), awayAvgConceded: r2(awayAvgConceded),
    awayScoreRate: pct(aGames, m => (m.goals?.away ?? 0) > 0),
    lambdaHome: r2(lambdaHome), lambdaAway: r2(lambdaAway), lambdaTotal: r2(lambdaTotal),
    over15Prob: matrix.over15Prob, over25Prob: matrix.over25Prob, ggProb: matrix.ggProb,
    homeWin: matrix.homeWin, draw: matrix.draw, awayWin: matrix.awayWin,
    h2hOver15: pct(h2h, m => ((m.goals?.home ?? 0) + (m.goals?.away ?? 0)) > 1),
    h2hGG:     pct(h2h, m => (m.goals?.home ?? 0) > 0 && (m.goals?.away ?? 0) > 0),
    h2hSample: h2h.length, confidence,
    homeForm, awayForm, h2hForm
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  const { id, h, a, br } = req.query;
  if (!id) return res.status(400).json({ error: 'Parametrul id este necesar' });
  if (!h || !a) return res.status(400).json({ error: 'Parametrii h si a sunt necesari' });

  const hId      = Number(h);
  const aId      = Number(a);
  const bankroll = parseFloat(br) || 10;
  const hdr      = { 'x-apisports-key': key };

  try {
    const [rFix, rLineups, rPlayers, rEvents, rHForm, rAForm, rH2H, rOdds] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/fixtures?id=${id}`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures/lineups?fixture=${id}`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures/players?fixture=${id}`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures/events?fixture=${id}`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures?team=${h}&last=20&status=FT`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures?team=${a}&last=20&status=FT`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${h}-${a}&last=10`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/odds?fixture=${id}&bookmaker=8`, { headers: hdr }),
    ]);

    const [dFix, dLineups, dPlayers, dEvents, dHForm, dAForm, dH2H, dOdds] = await Promise.all([
      rFix.json(), rLineups.json(), rPlayers.json(), rEvents.json(),
      rHForm.json(), rAForm.json(), rH2H.json(), rOdds.json(),
    ]);

    const fixture = (dFix.response || [])[0] || null;
    const lineups = dLineups.response || [];
    const players = dPlayers.response || [];
    const events  = dEvents.response  || [];

    const hGames = (dHForm.response || []).filter(m => m.teams?.home?.id === hId).slice(0, 10);
    const aGames = (dAForm.response || []).filter(m => m.teams?.away?.id === aId).slice(0, 10);
    const h2h    = (dH2H.response   || []).slice(0, 10);

    // Odds — try fixture, fallback to league if empty
    let oddsRaw = null;
    const oddsItem = (dOdds.response || [])[0];
    if (oddsItem) {
      oddsRaw = parseOddsItem(oddsItem);
    }
    if (!oddsRaw && fixture?.league?.id) {
      try {
        const rOdds2 = await fetch(
          `https://v3.football.api-sports.io/odds?league=${fixture.league.id}&season=2026&bookmaker=8`,
          { headers: hdr }
        );
        const dOdds2 = await rOdds2.json();
        const item2  = (dOdds2.response || []).find(x => x.fixture?.id === Number(id));
        if (item2) oddsRaw = parseOddsItem(item2);
      } catch (_) { /* odds unavailable */ }
    }

    const poissonResult = calcPoisson(hGames, aGames, h2h, hId);
    const evData        = calcEV(poissonResult, oddsRaw, bankroll);
    const enrich        = { ...poissonResult, ...evData };

    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_KEY;
    if (sbUrl && sbKey && fixture) {
      fetch(`${sbUrl}/rest/v1/predictions`, {
        method: 'POST',
        headers: {
          'apikey':        sbKey,
          'Authorization': `Bearer ${sbKey}`,
          'Content-Type':  'application/json',
          'Prefer':        'resolution=ignore-duplicates,return=minimal'
        },
        body: JSON.stringify({
          fixture_id:      fixture.fixture?.id,
          home_team:       fixture.teams?.home?.name || '',
          away_team:       fixture.teams?.away?.name || '',
          league_name:     fixture.league?.name      || '',
          league_id:       fixture.league?.id        || null,
          match_date:      fixture.fixture?.date     || null,
          lambda_home:     enrich.lambdaHome,
          lambda_away:     enrich.lambdaAway,
          lambda_total:    enrich.lambdaTotal,
          over15_prob:     enrich.over15Prob,
          over25_prob:     enrich.over25Prob,
          gg_prob:         enrich.ggProb,
          home_score_rate: enrich.homeScoreRate,
          away_score_rate: enrich.awayScoreRate,
          h2h_over15:      enrich.h2hOver15,
          confidence:      enrich.confidence,
        })
      }).catch(() => {});
    }

    const flatPlayers = players.flatMap(team =>
      (team.players || []).map(p => ({
        id:          p.player?.id,
        name:        p.player?.name,
        teamId:      team.team?.id,
        teamName:    team.team?.name,
        photo:       p.player?.photo,
        rating:      parseFloat(p.statistics?.[0]?.games?.rating) || null,
        minutes:     p.statistics?.[0]?.games?.minutes || 0,
        goals:       p.statistics?.[0]?.goals?.total   || 0,
        assists:     p.statistics?.[0]?.goals?.assists  || 0,
        passAcc:     p.statistics?.[0]?.passes?.accuracy || null,
        dribbles:    p.statistics?.[0]?.dribbles?.success || 0,
        yellowCards: p.statistics?.[0]?.cards?.yellow   || 0,
        redCards:    p.statistics?.[0]?.cards?.red      || 0,
        position:    p.statistics?.[0]?.games?.position || ''
      }))
    ).sort((a, b) => (b.rating || 0) - (a.rating || 0));

    res.status(200).json({ fixture, lineups, players: flatPlayers, events, enrich });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
