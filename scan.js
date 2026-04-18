export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { endpoint, ...params } = req.query;

  if (!endpoint) {
    return res.status(400).json({ error: 'Missing endpoint' });
  }

  // API key — from env variable or query param (env is safer)
  const apiKey = process.env.API_FOOTBALL_KEY || params.key;

  if (!apiKey) {
    return res.status(400).json({ error: 'Missing API key' });
  }

  // Build URL
  const queryParams = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (k !== 'key') queryParams.append(k, v);
  });

  const url = `https://v3.football.api-sports.io/${endpoint}${queryParams.toString() ? '?' + queryParams.toString() : ''}`;

  try {
    const response = await fetch(url, {
      headers: {
        'x-apisports-key': apiKey,
        'x-rapidapi-host': 'v3.football.api-sports.io'
      }
    });

    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
