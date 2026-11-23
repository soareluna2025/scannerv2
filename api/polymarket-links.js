import { query } from './db.js';

// Legaturi Polymarket {fixture_id: slug} pentru meciurile din fereastra apropiata (read-only).
export default async function handler(req, res) {
  try {
    const r = await query(
      "SELECT l.fixture_id, l.slug FROM polymarket_links l JOIN fixtures f ON f.fixture_id = l.fixture_id WHERE f.match_date > now() - interval '1 day' AND f.match_date < now() + interval '12 days'"
    );
    const links = {};
    r.rows.forEach(x => { links[x.fixture_id] = x.slug; });
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json({ links });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
