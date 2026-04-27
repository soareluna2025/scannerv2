export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  const { h, a } = req.query;
  if (!h || !a) return res.status(400).json({ error: 'Parametri h si a sunt necesari' });

  try {
    const [h2hRes, homeRes, awayRes] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${h}-${a}&last=10`, { headers: { 'x-apisports-key': key } }),
      fetch(`https://v3.football.api-sports.io/fixtures?team=${h}&last=5&status=FT`, { headers: { 'x-apisports-key': key } }),
      fetch(`https://v3.football.api-sports.io/fixtures?team=${a}&last=5&status=FT`, { headers: { 'x-apisports-key': key } })
    ]);
    const [h2hData, homeData, awayData] = await Promise.all([h2hRes.json(), homeRes.json(), awayRes.json()]);
    res.status(200).json({
      h2h: h2hData.response || [],
      homeForm: homeData.response || [],
      awayForm: awayData.response || []
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
