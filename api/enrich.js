export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  const { h, a } = req.query;
  if (!h || !a) return res.status(400).json({ error: 'Parametri h si a sunt necesari' });

  try {
    const hdr = { 'x-apisports-key': key };
    const hId = Number(h);
    const aId = Number(a);

    const [r1, r2, r3] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${h}-${a}&last=10`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures?team=${h}&last=20&status=FT`, { headers: hdr }),
      fetch(`https://v3.football.api-sports.io/fixtures?team=${a}&last=20&status=FT`, { headers: hdr })
    ]);
    const [d1, d2, d3] = await Promise.all([r1.json(), r2.json(), r3.json()]);

    const h2h      = (d1.response || []).slice(0, 10);
    const hGames   = (d2.response || []).filter(m => m.teams?.home?.id === hId).slice(0, 10);
    const aGames   = (d3.response || []).filter(m => m.teams?.away?.id === aId).slice(0, 10);

    const pct = (arr, fn) => arr.length ? Math.round(arr.filter(fn).length / arr.length * 100) : null;

    res.status(200).json({
      homeScoreRate: pct(hGames, m => (m.goals?.home ?? 0) > 0),
      awayScoreRate: pct(aGames, m => (m.goals?.away ?? 0) > 0),
      h2hOver15:     pct(h2h,    m => ((m.goals?.home ?? 0) + (m.goals?.away ?? 0)) > 1),
      h2hGG:         pct(h2h,    m => (m.goals?.home ?? 0) > 0 && (m.goals?.away ?? 0) > 0),
      h2hSample:     h2h.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
