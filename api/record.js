// POST /api/record — inserts a prediction into Supabase
// The predictions table must exist (see SQL comment below):
//
// CREATE TABLE predictions (
//   id               SERIAL PRIMARY KEY,
//   fixture_id       INTEGER UNIQUE,
//   home_team        TEXT,
//   away_team        TEXT,
//   league_name      TEXT,
//   league_id        INTEGER,
//   match_date       TIMESTAMP,
//   lambda_home      FLOAT,
//   lambda_away      FLOAT,
//   lambda_total     FLOAT,
//   over15_prob      FLOAT,
//   over25_prob      FLOAT,
//   gg_prob          FLOAT,
//   home_score_rate  FLOAT,
//   away_score_rate  FLOAT,
//   h2h_over15       FLOAT,
//   confidence       TEXT,
//   actual_home_goals INTEGER,
//   actual_away_goals INTEGER,
//   result_over15    BOOLEAN,
//   result_gg        BOOLEAN,
//   recorded_at      TIMESTAMP DEFAULT NOW()
// );

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_KEY;
  if (!sbUrl || !sbKey) return res.status(500).json({ error: 'Supabase not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body?.fixture_id) return res.status(400).json({ error: 'fixture_id required' });

    const r = await fetch(`${sbUrl}/rest/v1/predictions`, {
      method: 'POST',
      headers: {
        'apikey':          sbKey,
        'Authorization':   `Bearer ${sbKey}`,
        'Content-Type':    'application/json',
        'Prefer':          'resolution=ignore-duplicates,return=minimal'
      },
      body: JSON.stringify({
        fixture_id:      Number(body.fixture_id),
        home_team:       body.home_team       || '',
        away_team:       body.away_team       || '',
        league_name:     body.league_name     || '',
        league_id:       body.league_id       ? Number(body.league_id) : null,
        match_date:      body.match_date      || null,
        lambda_home:     body.lambda_home     ?? null,
        lambda_away:     body.lambda_away     ?? null,
        lambda_total:    body.lambda_total    ?? null,
        over15_prob:     body.over15_prob     ?? null,
        over25_prob:     body.over25_prob     ?? null,
        gg_prob:         body.gg_prob         ?? null,
        home_score_rate: body.home_score_rate ?? null,
        away_score_rate: body.away_score_rate ?? null,
        h2h_over15:      body.h2h_over15      ?? null,
        confidence:      body.confidence      || null,
      })
    });

    if (!r.ok) return res.status(500).json({ error: await r.text() });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
