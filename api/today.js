export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  // Today's date in YYYY-MM-DD (UTC)
  const today = new Date().toISOString().split('T')[0];

  try {
    // Fetch upcoming (NS = Not Started) fixtures for today
    const r = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${today}&status=NS`,
      { headers: { 'x-apisports-key': key } }
    );
    const data = await r.json();

    if (data.errors && Object.keys(data.errors).length > 0) {
      return res.status(403).json({ error: JSON.stringify(data.errors) });
    }

    res.status(200).json({ response: data.response || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
