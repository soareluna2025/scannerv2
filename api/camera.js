import { query } from './db.js';
import { normSettings } from './utils/camera-core.js';

// Camera — API intern (auth x-api-key, vezi PROTECTED_API in server.js). Aloha executa DOAR intrarile puse de utilizator.
export async function ensureCameraTables() {
  await query("CREATE TABLE IF NOT EXISTS camera_settings (k TEXT PRIMARY KEY, v JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())");
  await query("CREATE TABLE IF NOT EXISTS camera_entries (id SERIAL PRIMARY KEY, fixture_id BIGINT NOT NULL, market TEXT NOT NULL DEFAULT 'over05', match_label TEXT, kickoff TIMESTAMPTZ, stake NUMERIC, pmin INTEGER, pmax INTEGER, status TEXT NOT NULL DEFAULT 'waiting', mode TEXT, trigger_price NUMERIC, triggered_at TIMESTAMPTZ, last_price NUMERIC, result TEXT, pnl NUMERIC, note TEXT, created_at TIMESTAMPTZ DEFAULT now())");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS camera_entries_fx_market_active ON camera_entries (fixture_id, market) WHERE status IN ('waiting','triggered')");
}
export async function loadSettings() {
  const r = await query("SELECT v FROM camera_settings WHERE k='main'");
  return normSettings(r.rows[0]?.v);
}

let _geo = { at: 0, v: null };
// Semafor geoblock: verifica IP-ul SERVERULUI (nu al tau). Doar informativ; Camera nu plaseaza ordine.
async function geoblock() {
  if (Date.now() - _geo.at < 5 * 60 * 1000 && _geo.v) return _geo.v;
  try {
    const r = await fetch('https://polymarket.com/api/geoblock', { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    _geo = { at: Date.now(), v: { ok: true, blocked: !!j.blocked, country: j.country || null } };
  } catch (e) { _geo = { at: Date.now(), v: { ok: false, blocked: null, country: null } }; }
  return _geo.v;
}

export default async function handler(req, res) {
  try {
    await ensureCameraTables();
    if (req.method === 'GET') {
      const settings = await loadSettings();
      const entries = (await query("SELECT * FROM camera_entries ORDER BY (status IN ('waiting','triggered')) DESC, kickoff DESC NULLS LAST, id DESC LIMIT 200")).rows;
      const st = (await query(`SELECT
        COALESCE(SUM(stake) FILTER (WHERE triggered_at::date = CURRENT_DATE),0) AS spent_today,
        COALESCE(SUM(pnl) FILTER (WHERE triggered_at::date = CURRENT_DATE),0) AS pnl_today,
        COALESCE(SUM(pnl) FILTER (WHERE triggered_at > now() - interval '7 days'),0) AS pnl_week,
        COALESCE(SUM(pnl),0) AS pnl_total,
        COUNT(*) FILTER (WHERE result='win') AS wins, COUNT(*) FILTER (WHERE result IS NOT NULL) AS settled,
        AVG(trigger_price) FILTER (WHERE result IS NOT NULL) AS avg_price
        FROM camera_entries`)).rows[0];
      const geo = await geoblock();
      return res.status(200).json({ ok: true, settings, entries, stats: st, geo });
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
      const s = await loadSettings();
      const fx = (await query("SELECT home_team_name, away_team_name, match_date FROM fixtures WHERE fixture_id=$1", [fid])).rows[0];
      const label = b.match_label || (fx ? fx.home_team_name + ' – ' + fx.away_team_name : String(fid));
      const r = await query(
        "INSERT INTO camera_entries (fixture_id, market, match_label, kickoff, stake, pmin, pmax) VALUES ($1,'over05',$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id",
        [fid, label, fx?.match_date || null, Number(b.stake) || s.stake, Number(b.pmin) || s.pmin, Number(b.pmax) || s.pmax]);
      return res.status(200).json({ ok: true, id: r.rows[0]?.id || null, duplicate: !r.rows[0] });
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
