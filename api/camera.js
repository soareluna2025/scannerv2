import { query } from './db.js';
import { normSettings, MARKETS } from './utils/camera-core.js';

// AlohaPoly (fosta Camera) — API intern (auth x-api-key, PROTECTED_API in server.js). Aloha executa DOAR intrarile puse de utilizator.
export async function ensureCameraTables() {
  await query("CREATE TABLE IF NOT EXISTS camera_settings (k TEXT PRIMARY KEY, v JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())");
  await query("CREATE TABLE IF NOT EXISTS camera_entries (id SERIAL PRIMARY KEY, fixture_id BIGINT NOT NULL, market TEXT NOT NULL DEFAULT 'over05', match_label TEXT, kickoff TIMESTAMPTZ, stake NUMERIC, pmin INTEGER, pmax INTEGER, status TEXT NOT NULL DEFAULT 'waiting', mode TEXT, trigger_price NUMERIC, triggered_at TIMESTAMPTZ, last_price NUMERIC, result TEXT, pnl NUMERIC, note TEXT, created_at TIMESTAMPTZ DEFAULT now())");
  await query("ALTER TABLE camera_entries ADD COLUMN IF NOT EXISTS live_from INTEGER");
  await query("ALTER TABLE camera_entries ADD COLUMN IF NOT EXISTS live_to INTEGER");
  await query("DROP INDEX IF EXISTS camera_entries_fx_market_active");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS camera_entries_fx_market_active2 ON camera_entries (fixture_id, market) WHERE status IN ('waiting','triggered')");
}
export async function loadSettings() {
  const r = await query("SELECT v FROM camera_settings WHERE k='main'");
  return normSettings(r.rows[0]?.v);
}

let _geo = { at: 0, v: null };
// Semafor geoblock: verifica IP-ul SERVERULUI (nu al tau). Informativ; Camera nu plaseaza ordine.
async function geoblock() {
  if (Date.now() - _geo.at < 5 * 60 * 1000 && _geo.v) return _geo.v;
  try {
    const j = await (await fetch('https://polymarket.com/api/geoblock', { signal: AbortSignal.timeout(6000) })).json();
    _geo = { at: Date.now(), v: { ok: true, blocked: !!j.blocked, country: j.country || null } };
  } catch (e) { _geo = { at: Date.now(), v: { ok: false, blocked: null, country: null } }; }
  return _geo.v;
}
const numOrNull = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

export default async function handler(req, res) {
  try {
    await ensureCameraTables();
    if (req.method === 'GET') {
      // Cautare personala de meciuri: ?q=echipa (urmatoarele 8 zile + azi)
      if (req.query?.q) {
        const q = '%' + String(req.query.q).trim().slice(0, 60) + '%';
        const r = await query(`SELECT f.fixture_id, f.home_team_name, f.away_team_name, f.match_date, (l.fixture_id IS NOT NULL) AS has_poly
          FROM fixtures f LEFT JOIN polymarket_links l ON l.fixture_id = f.fixture_id
          WHERE f.match_date > now() - interval '3 hours' AND f.match_date < now() + interval '9 days'
            AND (f.home_team_name ILIKE $1 OR f.away_team_name ILIKE $1) ORDER BY f.match_date LIMIT 25`, [q]);
        return res.status(200).json({ ok: true, results: r.rows });
      }
      const settings = await loadSettings();
      const entries = (await query("SELECT * FROM camera_entries ORDER BY (status IN ('waiting','triggered')) DESC, kickoff ASC NULLS LAST, id DESC LIMIT 200")).rows;
      const st = (await query(`SELECT
        COALESCE(SUM(stake) FILTER (WHERE triggered_at::date = CURRENT_DATE),0) AS spent_today,
        COALESCE(SUM(pnl) FILTER (WHERE triggered_at::date = CURRENT_DATE),0) AS pnl_today,
        COALESCE(SUM(pnl) FILTER (WHERE triggered_at > now() - interval '7 days'),0) AS pnl_week,
        COALESCE(SUM(pnl),0) AS pnl_total,
        COALESCE(SUM(stake) FILTER (WHERE status='triggered'),0) AS open_stake,
        COUNT(*) FILTER (WHERE result='win') AS wins, COUNT(*) FILTER (WHERE result IS NOT NULL) AS settled,
        AVG(trigger_price) FILTER (WHERE result IS NOT NULL) AS avg_price
        FROM camera_entries`)).rows[0];
      // Rata reala vs pret pe intervale de 2c (doar intrari decontate)
      const buckets = (await query(`SELECT (floor(trigger_price*100/2)*2)::int AS lo, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE result='win')::int AS wins, AVG(trigger_price)::float AS avg_price
        FROM camera_entries WHERE result IS NOT NULL AND trigger_price IS NOT NULL GROUP BY 1 ORDER BY 1`)).rows;
      const geo = await geoblock();
      return res.status(200).json({ ok: true, settings, entries, stats: st, buckets, geo });
    }
    const b = req.body || {};
    if (b.action === 'settings') {
      const merged = normSettings({ ...(await loadSettings()), ...(b.settings || {}) });
      await query("INSERT INTO camera_settings (k,v) VALUES ('main',$1) ON CONFLICT (k) DO UPDATE SET v=$1, updated_at=now()", [JSON.stringify(merged)]);
      return res.status(200).json({ ok: true, settings: merged });
    }
    if (b.action === 'add') {
      const fid = Number(b.fixture_id);
      if (!Number.isFinite(fid)) return res.status(400).json({ ok: false, error: 'fixture_id invalid' });
      const market = MARKETS.includes(b.market) ? b.market : 'over05';
      const s = await loadSettings();
      const fx = (await query("SELECT home_team_name, away_team_name, match_date FROM fixtures WHERE fixture_id=$1", [fid])).rows[0];
      const label = b.match_label || (fx ? fx.home_team_name + ' – ' + fx.away_team_name : String(fid));
      const r = await query(
        "INSERT INTO camera_entries (fixture_id, market, match_label, kickoff, stake, pmin, pmax, live_from, live_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id",
        [fid, market, label, fx?.match_date || null, numOrNull(b.stake) ?? s.stake, numOrNull(b.pmin) ?? s.pmin, numOrNull(b.pmax) ?? s.pmax, numOrNull(b.live_from), numOrNull(b.live_to)]);
      return res.status(200).json({ ok: true, id: r.rows[0]?.id || null, duplicate: !r.rows[0] });
    }
    if (b.action === 'update') {
      const sets = [], vals = [Number(b.id)];
      const add = (col, v) => { vals.push(v); sets.push(col + '=$' + vals.length); };
      if (MARKETS.includes(b.market)) add('market', b.market);
      for (const k of ['stake', 'pmin', 'pmax', 'live_from', 'live_to']) if (k in b) add(k, numOrNull(b[k]));
      if (!sets.length) return res.status(400).json({ ok: false, error: 'nimic de actualizat' });
      await query(`UPDATE camera_entries SET ${sets.join(', ')}, note=NULL WHERE id=$1 AND status='waiting'`, vals);
      return res.status(200).json({ ok: true });
    }
    if (b.action === 'cancel') {
      await query("UPDATE camera_entries SET status='cancelled' WHERE id=$1 AND status='waiting'", [Number(b.id)]);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: 'action necunoscuta' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
