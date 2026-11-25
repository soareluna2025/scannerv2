import { query } from './db.js';

// Pret live de CUMPARARE (best ask) pe piata Over 0.5, per meci — doar CITIRE din datele publice Polymarket.
// GET /api/polymarket-prices?ids=1,2,3  ->  { ok, prices: { "<fixture_id>": { c: 88.5, ts } } }   (c = cenți)
const GAMMA = 'https://gamma-api.polymarket.com', CLOB = 'https://clob.polymarket.com';
const tokenCache = new Map();   // slug -> { token, at }   (15 min; negativ 2 min)
const priceCache = new Map();   // token -> { c, at }      (4 s)
const j = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(6000) }); if (!r.ok) throw new Error(r.status); return r.json(); };

async function over05Token(slug) {
  const hit = tokenCache.get(slug);
  if (hit && Date.now() - hit.at < (hit.token ? 15 * 60e3 : 2 * 60e3)) return hit.token;
  let token = null;
  try {
    const ev = await j(`${GAMMA}/events?slug=${encodeURIComponent(slug + '-more-markets')}`);
    const m = (ev[0]?.markets || []).find(x => /O\/U 0\.5\s*$/i.test(x.question || x.groupItemTitle || ''));
    if (m) {
      const ids = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
      const outs = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
      token = ids?.[Math.max(0, (outs || []).findIndex(o => /over/i.test(o)))] || null;
    }
  } catch { /* ramane null */ }
  tokenCache.set(slug, { token, at: Date.now() });
  return token;
}
async function askCents(token) {
  const hit = priceCache.get(token);
  if (hit && Date.now() - hit.at < 4000) return hit.c;
  let c = null;
  try {
    const b = await j(`${CLOB}/book?token_id=${token}`);
    const asks = (b.asks || []).map(a => Number(a.price)).filter(Number.isFinite);
    if (asks.length) c = Math.round(Math.min(...asks) * 100);
  } catch { /* ramane null */ }
  priceCache.set(token, { c, at: Date.now() });
  return c;
}

export default async function handler(req, res) {
  try {
    const ids = String(req.query?.ids || '').split(',').map(Number).filter(Number.isFinite).slice(0, 40);
    if (!ids.length) return res.status(200).json({ ok: true, prices: {} });
    const rows = (await query('SELECT fixture_id, slug FROM polymarket_links WHERE fixture_id = ANY($1)', [ids])).rows;
    const prices = {};
    for (let i = 0; i < rows.length; i += 8) {   // max 8 cereri in paralel
      await Promise.all(rows.slice(i, i + 8).map(async (r) => {
        const token = await over05Token(r.slug);
        prices[r.fixture_id] = { c: token ? await askCents(token) : null, ts: Date.now() };
      }));
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, prices });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
