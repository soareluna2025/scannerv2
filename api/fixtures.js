export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const API_KEY = process.env.API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'API_KEY not configured on server' });

  try {
    const r = await fetch(
      'https://v3.football.api-sports.io/fixtures?live=all',
      {
        headers: {
          'x-apisports-key': API_KEY
        }
      }
    );

    const data = await r.json();

    if (data.errors && Object.keys(data.errors).length > 0) {
      return res.status(401).json({ error: 'API key invalid: ' + JSON.stringify(data.errors) });
    }

    res.status(200).json(data.response || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
