import { query } from './db.js';

// Evenimente trimise de utilizator din Ponturi in calendarul Compus.
// GET (public, read-only) -> {events:[...]}; POST / DELETE -> protejate in server.js (x-api-key).
// Un singur eveniment per meci (UNIQUE fixture_id) = o singura piata per meci.
let _ready = null;
function ensureTable() {
  if (!_ready) {
    _ready = query(`
      CREATE TABLE IF NOT EXISTS calendar_events (
        fixture_id   BIGINT PRIMARY KEY,
        kickoff      TIMESTAMPTZ NOT NULL,
        home         TEXT NOT NULL,
        away         TEXT NOT NULL,
        home_id      INTEGER,
        away_id      INTEGER,
        league_name  TEXT,
        country      TEXT,
        market       TEXT NOT NULL,
        p_cal        NUMERIC,
        confidence   NUMERIC,
        slug         TEXT,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )`).catch(e => { _ready = null; throw e; });
  }
  return _ready;
}

const str = (v, n) => (v == null ? null : String(v).slice(0, n));
const intOrNull = v => { const x = parseInt(v, 10); return Number.isFinite(x) ? x : null; };
const numOrNull = v => { const x = Number(v); return v != null && v !== '' && Number.isFinite(x) ? x : null; };

export default async function handler(req, res) {
  try {
    await ensureTable();

    if (req.method === 'GET') {
      const r = await query(
        `SELECT fixture_id, kickoff, home, away, home_id, away_id, league_name, country,
                market, p_cal, confidence, slug
           FROM calendar_events
          WHERE kickoff > now() - interval '120 days'
          ORDER BY kickoff`
      );
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ events: r.rows });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const fid = intOrNull(b.fixture_id);
      const ko = new Date(b.kickoff);
      if (!fid || isNaN(ko.getTime()) || !b.home || !b.away || !b.market) {
        return res.status(400).json({ ok: false, error: 'fixture_id, kickoff, home, away, market obligatorii' });
      }
      const ins = await query(
        `INSERT INTO calendar_events
           (fixture_id, kickoff, home, away, home_id, away_id, league_name, country, market, p_cal, confidence, slug)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (fixture_id) DO NOTHING
         RETURNING fixture_id`,
        [fid, ko.toISOString(), str(b.home, 120), str(b.away, 120), intOrNull(b.home_id), intOrNull(b.away_id),
         str(b.league_name, 120), str(b.country, 80), str(b.market, 60), numOrNull(b.p_cal), numOrNull(b.confidence),
         str(b.slug, 200)]
      );
      return res.status(200).json({ ok: true, created: ins.rowCount === 1 });
    }

    if (req.method === 'DELETE') {
      const fid = intOrNull((req.query && req.query.fixture_id) || (req.body && req.body.fixture_id));
      if (!fid) return res.status(400).json({ ok: false, error: 'fixture_id obligatoriu' });
      const del = await query('DELETE FROM calendar_events WHERE fixture_id = $1', [fid]);
      return res.status(200).json({ ok: true, removed: del.rowCount });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
