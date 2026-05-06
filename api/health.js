// GET /api/health — shows which env vars are configured and tests connectivity
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const cfg = {
    API_FOOTBALL_KEY: !!(process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY),
    FOOTBALL_DATA_KEY: !!process.env.FOOTBALL_DATA_KEY,
    SUPABASE_URL:      !!process.env.SUPABASE_URL,
    SUPABASE_KEY:      !!process.env.SUPABASE_KEY,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    XAI_API_KEY:       !!(process.env.XAI_API_KEY || process.env.GROQ_KEY),
    TELEGRAM_BOT_TOKEN: !!process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID:   !!process.env.TELEGRAM_CHAT_ID,
  };

  const missing = Object.entries(cfg).filter(([, v]) => !v).map(([k]) => k);
  const present = Object.entries(cfg).filter(([, v]) => v).map(([k]) => k);

  // Quick live test of API-Football key
  let afStatus = 'skipped';
  const afKey = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (afKey) {
    try {
      const r = await fetch('https://v3.football.api-sports.io/status', {
        headers: { 'x-apisports-key': afKey }
      });
      const d = await r.json();
      if (d.response?.account) {
        afStatus = `ok — plan: ${d.response.subscription?.plan || '?'}, remaining: ${d.response.requests?.current ?? '?'}/${d.response.requests?.limit_day ?? '?'}`;
      } else if (d.errors) {
        afStatus = `error: ${JSON.stringify(d.errors)}`;
      } else {
        afStatus = 'ok';
      }
    } catch (e) {
      afStatus = `fetch error: ${e.message}`;
    }
  }

  // Quick Supabase connectivity test
  let sbStatus = 'skipped';
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_KEY;
  if (sbUrl && sbKey) {
    try {
      const r = await fetch(`${sbUrl}/rest/v1/predictions?limit=1`, {
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` }
      });
      if (r.ok) {
        const rows = await r.json();
        sbStatus = `ok — predictions table has ${Array.isArray(rows) ? rows.length + '+ rows (queried 1)' : '?'}`;
      } else {
        const txt = await r.text();
        sbStatus = `error ${r.status}: ${txt.slice(0, 200)}`;
      }
    } catch (e) {
      sbStatus = `fetch error: ${e.message}`;
    }
  }

  const allRequired = cfg.API_FOOTBALL_KEY && cfg.SUPABASE_URL && cfg.SUPABASE_KEY;

  return res.status(200).json({
    ok: allRequired,
    timestamp: new Date().toISOString(),
    env: { present, missing },
    tests: {
      api_football: afStatus,
      supabase: sbStatus,
    },
    notes: missing.length
      ? `Missing env vars — add to Vercel dashboard: ${missing.join(', ')}`
      : 'All required env vars configured',
  });
}
