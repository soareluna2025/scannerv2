export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, league, season = new Date().getFullYear().toString() } = req.query;

  if (type === 'standings') {
    const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
    if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });
    if (!league) return res.status(400).json({ error: 'Parametru liga lipsa' });
    try {
      const r = await fetch(
        `https://v3.football.api-sports.io/standings?league=${league}&season=${season}`,
        { headers: { 'x-apisports-key': key } }
      );
      const data = await r.json();
      if (data.errors && Object.keys(data.errors).length > 0)
        return res.status(403).json({ error: 'API error: ' + JSON.stringify(data.errors) });
      return res.status(200).json({ response: data.response || [] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (type === 'predictions' || !type) {
    const sbUrl = process.env.SUPABASE_URL;
    const sbKey = process.env.SUPABASE_KEY;
    if (!sbUrl || !sbKey) return res.status(500).json({ error: 'Supabase neconfigurat' });
    try {
      const r = await fetch(
        `${sbUrl}/rest/v1/predictions?select=home_team,away_team,league_name,match_date,over15_prob,result_over15&order=recorded_at.desc&limit=50`,
        { headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` } }
      );
      const rows = await r.json();
      if (!r.ok) return res.status(500).json({ error: JSON.stringify(rows) });
      const resolved = rows.filter(p => p.result_over15 !== null);
      const wins = resolved.filter(p => p.result_over15 === true).length;
      const winRate = resolved.length > 0 ? Math.round(wins / resolved.length * 100) : null;
      return res.status(200).json({ predictions: rows, winRate, total: rows.length, resolved: resolved.length });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'type trebuie sa fie predictions sau standings' });
}
