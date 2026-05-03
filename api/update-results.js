// Cron: GET /api/update-results (runs hourly)
// Fetches pending predictions (no actual result yet) and fills in the real score.

export default async function handler(req, res) {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_KEY;
  const afKey = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;

  if (!sbUrl || !sbKey) return res.status(500).json({ error: 'Supabase not configured' });
  if (!afKey)           return res.status(500).json({ error: 'API_FOOTBALL_KEY not configured' });

  try {
    const now = new Date().toISOString();
    const r = await fetch(
      `${sbUrl}/rest/v1/predictions?actual_home_goals=is.null&match_date=lt.${now}&select=id,fixture_id&limit=100`,
      { headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` } }
    );
    if (!r.ok) return res.status(500).json({ error: await r.text() });

    const pending = await r.json();
    if (!Array.isArray(pending) || !pending.length) {
      return res.status(200).json({ updated: 0, total: 0 });
    }

    let updated = 0;
    const hdr = { 'x-apisports-key': afKey };

    for (const pred of pending) {
      try {
        const fr  = await fetch(`https://v3.football.api-sports.io/fixtures?id=${pred.fixture_id}`, { headers: hdr });
        const fd  = await fr.json();
        const fix = fd.response?.[0];
        if (!fix) continue;

        const status = fix.fixture?.status?.short;
        if (!['FT', 'AET', 'PEN'].includes(status)) continue;

        const hg = fix.goals?.home;
        const ag = fix.goals?.away;
        if (hg == null || ag == null) continue;

        const pr = await fetch(
          `${sbUrl}/rest/v1/predictions?fixture_id=eq.${pred.fixture_id}`,
          {
            method: 'PATCH',
            headers: {
              'apikey':        sbKey,
              'Authorization': `Bearer ${sbKey}`,
              'Content-Type':  'application/json',
              'Prefer':        'return=minimal'
            },
            body: JSON.stringify({
              actual_home_goals: hg,
              actual_away_goals: ag,
              result_over15:     (hg + ag) >= 2,
              result_gg:         hg > 0 && ag > 0
            })
          }
        );
        if (pr.ok) updated++;
      } catch (_) { /* skip fixture, try next */ }
    }

    return res.status(200).json({ updated, total: pending.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
