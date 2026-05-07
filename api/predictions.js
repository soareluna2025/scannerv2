export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

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
