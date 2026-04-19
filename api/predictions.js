export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  const { league, season = '2024' } = req.query;
  if (!league) return res.status(400).json({ error: 'Parametru liga lipsa' });

  try {
    const r = await fetch(
      `https://v3.football.api-sports.io/fixtures?league=${league}&season=${season}&next=10`,
      { headers: { 'x-apisports-key': key } }
    );
    const data = await r.json();

    if (data.errors && Object.keys(data.errors).length > 0) {
      return res.status(403).json({ error: 'API error: ' + JSON.stringify(data.errors) });
    }

    const fixtures = data.response || [];
    if (!fixtures.length) return res.status(200).json({ predictions: [] });

    const top5 = fixtures.slice(0, 5);
    const predictions = await Promise.all(top5.map(async (fx) => {
      try {
        const pr = await fetch(
          `https://v3.football.api-sports.io/predictions?fixture=${fx.fixture.id}`,
          { headers: { 'x-apisports-key': key } }
        );
        const pd = await pr.json();
        return {
          fixture: fx,
          prediction: pd.response && pd.response[0] ? pd.response[0] : null
        };
      } catch (e) {
        return { fixture: fx, prediction: null };
      }
    }));

    const rest = fixtures.slice(5).map(fx => ({ fixture: fx, prediction: null }));
    res.status(200).json({ predictions: [...predictions, ...rest] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
