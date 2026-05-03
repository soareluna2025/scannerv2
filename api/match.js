function poissonP(lambda, k) {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

function calcPoisson(hGames, aGames, h2h) {
  const avg = (arr, fn) => arr.length ? arr.reduce((s, m) => s + fn(m), 0) / arr.length : 0;
  const pct = (arr, fn) => arr.length ? Math.round(arr.filter(fn).length / arr.length * 100) : null;
  const r2 = v => Math.round(v * 100) / 100;
  const r1 = v => Math.round(v * 10) / 10;

  const homeAvgScored   = avg(hGames, m => m.goals?.home ?? 0);
  const homeAvgConceded = avg(hGames, m => m.goals?.away ?? 0);
  const awayAvgScored   = avg(aGames, m => m.goals?.away ?? 0);
  const awayAvgConceded = avg(aGames, m => m.goals?.home ?? 0);
  const lambdaHome  = (homeAvgScored + awayAvgConceded) / 2;
  const lambdaAway  = (awayAvgScored + homeAvgConceded) / 2;
  const lambdaTotal = lambdaHome + lambdaAway;
  const over15Prob = (1 - poissonP(lambdaTotal, 0) - poissonP(lambdaTotal, 1)) * 100;
  const over25Prob = (1 - poissonP(lambdaTotal, 0) - poissonP(lambdaTotal, 1) - poissonP(lambdaTotal, 2)) * 100;
  const ggProb     = (1 - Math.exp(-lambdaHome)) * (1 - Math.exp(-lambdaAway)) * 100;
  const confidence = (h2h.length >= 8 && hGames.length >= 8 && aGames.length >= 8) ? 'HIGH'
                   : (h2h.length >= 5 && hGames.length >= 5 && aGames.length >= 5) ? 'MED' : 'LOW';

  // Last 5 form
  const formResult = (m, isHome) => {
    const hg = m.goals?.home ?? 0, ag = m.goals?.away ?? 0;
    if (isHome) return hg > ag ? 'W' : hg === ag ? 'D' : 'L';
    return ag > hg ? 'W' : hg === ag ? 'D' : 'L';
  };
  const homeForm = hGames.slice(0, 5).map(m => ({
    result: formResult(m, m.teams?.home?.id === hGames[0]?.teams?.home?.id),
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
    over15Prob: r1(over15Prob), over25Prob: r1(over25Prob), ggProb: r1(ggProb),
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

  const { id, h, a } = req.query;
  if (!id) return res.status(400).json({ error: 'Parametrul id este necesar' });
  if (!h || !a) return res.status(400).json({ error: 'Parametrii h si a sunt necesari' });

  const hId = Number(h);
  const aId = Number(a);
  const hdr = { 'x-apisports-key': key };

  try {
    const [rFix, rLineups, rPlayers, rEvents, rHForm, rAForm, rH2H] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/fixtures?id=${id}`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures/lineups?fixture=${id}`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures/players?fixture=${id}`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures/events?fixture=${id}`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures?team=${h}&last=20&status=FT`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures?team=${a}&last=20&status=FT`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${h}-${a}&last=10`, { headers: hdr })
    ]);

    const [dFix, dLineups, dPlayers, dEvents, dHForm, dAForm, dH2H] = await Promise.all([
      rFix.json(), rLineups.json(), rPlayers.json(), rEvents.json(),
      rHForm.json(), rAForm.json(), rH2H.json()
    ]);

    const fixture = (dFix.response || [])[0] || null;
    const lineups  = dLineups.response || [];
    const players  = dPlayers.response || [];
    const events   = dEvents.response  || [];

    const hGames = (dHForm.response || []).filter(m => m.teams?.home?.id === hId).slice(0, 10);
    const aGames = (dAForm.response || []).filter(m => m.teams?.away?.id === aId).slice(0, 10);
    const h2h    = (dH2H.response   || []).slice(0, 10);

    const enrich = calcPoisson(hGames, aGames, h2h);

    // Fire-and-forget prediction record to Supabase
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
          home_team:       fixture.teams?.home?.name  || '',
          away_team:       fixture.teams?.away?.name  || '',
          league_name:     fixture.league?.name       || '',
          league_id:       fixture.league?.id         || null,
          match_date:      fixture.fixture?.date      || null,
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

    // Normalise player stats
    const flatPlayers = players.flatMap(team =>
      (team.players || []).map(p => ({
        id:       p.player?.id,
        name:     p.player?.name,
        teamId:   team.team?.id,
        teamName: team.team?.name,
        photo:    p.player?.photo,
        rating:   parseFloat(p.statistics?.[0]?.games?.rating) || null,
        minutes:  p.statistics?.[0]?.games?.minutes || 0,
        goals:    p.statistics?.[0]?.goals?.total || 0,
        assists:  p.statistics?.[0]?.goals?.assists || 0,
        passAcc:  p.statistics?.[0]?.passes?.accuracy || null,
        dribbles: p.statistics?.[0]?.dribbles?.success || 0,
        yellowCards: p.statistics?.[0]?.cards?.yellow || 0,
        redCards:    p.statistics?.[0]?.cards?.red    || 0,
        position: p.statistics?.[0]?.games?.position || ''
      }))
    ).sort((a, b) => (b.rating || 0) - (a.rating || 0));

    res.status(200).json({ fixture, lineups, players: flatPlayers, events, enrich });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
