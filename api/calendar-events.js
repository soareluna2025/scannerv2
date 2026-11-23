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
      )`)
      .then(() => query('ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS buy_price NUMERIC, ADD COLUMN IF NOT EXISTS price_at TIMESTAMPTZ'))
      .catch(e => { _ready = null; throw e; });
  }
  return _ready;
}

// Pret de CUMPARARE (ask) pentru "Over 0.5" meci intreg, din Polymarket. Totalurile stau intr-un eveniment
// separat: <slug>-more-markets, piata "<Home> vs. <Away>: O/U 0.5" (fara "1st Half", fara piete pe echipa).
// Intoarce numar in (0,1) sau null (nu blocheaza niciodata trimiterea in calendar).
async function fetchOver05(slug) {
  if (!slug) return null;
  try {
    const r = await fetch('https://gamma-api.polymarket.com/events?slug=' + encodeURIComponent(slug) + '-more-markets',
      { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const ev = await r.json();
    const ms = (Array.isArray(ev) && ev[0] && ev[0].markets) || [];
    const m = ms.find(x => /: O\/U 0\.5$/.test(x.question || '') && !/1st Half/i.test(x.question || ''));
    if (!m) return null;
    const outs = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
    const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
    let i = Array.isArray(outs) ? outs.findIndex(o => /^over$/i.test(String(o))) : -1;
    if (i < 0) i = 0;   // primul rezultat = Over (ex. Over 0.5 la ~0.92)
    let p = i === 0 ? Number(m.bestAsk) : (m.bestBid != null ? 1 - Number(m.bestBid) : NaN);
    if (!(p > 0 && p < 1)) p = Number(prices && prices[i]);
    return p > 0 && p < 1 ? p : null;
  } catch (e) { return null; }
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
                market, p_cal, confidence, slug, buy_price, price_at
           FROM calendar_events
          WHERE kickoff > now() - interval '120 days'
          ORDER BY kickoff`
      );
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ events: r.rows });
    }

    // POST ?refresh_prices=1 -> reia pretul Over 0.5 pentru evenimentele care nu au inceput (si completeaza cele fara pret).
    if (req.method === 'POST' && req.query && req.query.refresh_prices) {
      const rows = (await query(
        "SELECT fixture_id, slug FROM calendar_events WHERE kickoff > now() AND slug IS NOT NULL ORDER BY kickoff LIMIT 40"
      )).rows;
      const got = await Promise.all(rows.map(async x => ({ id: x.fixture_id, p: await fetchOver05(x.slug) })));
      let updated = 0;
      for (const g of got) {
        if (g.p == null) continue;
        await query('UPDATE calendar_events SET buy_price = $2, price_at = now() WHERE fixture_id = $1', [g.id, g.p]);
        updated++;
      }
      return res.status(200).json({ ok: true, checked: rows.length, updated });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const fid = intOrNull(b.fixture_id);
      const ko = new Date(b.kickoff);
      if (!fid || isNaN(ko.getTime()) || !b.home || !b.away || !b.market) {
        return res.status(400).json({ ok: false, error: 'fixture_id, kickoff, home, away, market obligatorii' });
      }
      const slug = str(b.slug, 200);
      const price = await fetchOver05(slug);   // pretul de cumparare Over 0.5 in momentul trimiterii (null daca lipseste)
      const ins = await query(
        `INSERT INTO calendar_events
           (fixture_id, kickoff, home, away, home_id, away_id, league_name, country, market, p_cal, confidence, slug, buy_price, price_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $13::numeric IS NULL THEN NULL ELSE now() END)
         ON CONFLICT (fixture_id) DO NOTHING
         RETURNING fixture_id`,
        [fid, ko.toISOString(), str(b.home, 120), str(b.away, 120), intOrNull(b.home_id), intOrNull(b.away_id),
         str(b.league_name, 120), str(b.country, 80), str(b.market, 60), numOrNull(b.p_cal), numOrNull(b.confidence),
         slug, price]
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
