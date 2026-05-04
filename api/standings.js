export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  const { league, season = new Date().getFullYear().toString() } = req.query;
  if (!league) return res.status(400).json({ error: 'Parametru liga lipsa' });

  try {
    const r = await fetch(
      `https://v3.football.api-sports.io/standings?league=${league}&season=${season}`,
      { headers: { 'x-apisports-key': key } }
    );
    const data = await r.json();

    if (data.errors && Object.keys(data.errors).length > 0) {
      return res.status(403).json({ error: 'API error: ' + JSON.stringify(data.errors) });
    }

    res.status(200).json({ response: data.response || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
