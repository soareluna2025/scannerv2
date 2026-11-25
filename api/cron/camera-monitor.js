// camera-monitor.js — rulat din cron la 1 minut. DOAR CITIRE de la Polymarket (date publice). NU plaseaza ordine (nu exista cod de executie).
// Pentru fiecare intrare 'waiting': ia pretul Over 0.5, aplica regulile (api/utils/camera-core.js), marcheaza paper/alert si trimite Telegram (optional).
// La meciuri terminate: calculeaza rezultatul si PnL (paper).
import pool from '../db.js';
import { ensureCameraTables, loadSettings } from '../camera.js';
import { evaluate, settle, entryPhase } from '../utils/camera-core.js';

const GAMMA = 'https://gamma-api.polymarket.com', CLOB = 'https://clob.polymarket.com';
const j = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(u + ' -> ' + r.status); return r.json(); };

const PATTERNS = { over05: /O\/U 0\.5\s*$/i, over15: /O\/U 1\.5\s*$/i };   // home/away: numele pietelor se verifica cu scripts/camera-markets.mjs
async function marketToken(slug, market) {
  const re = PATTERNS[market];
  if (!re) return { token: null, note: 'piata ' + market + ' inca nemapata (ruleaza scripts/camera-markets.mjs)' };
  const ev = await j(`${GAMMA}/events?slug=${encodeURIComponent(slug + '-more-markets')}`);
  const m = (ev[0]?.markets || []).find(x => re.test(x.question || x.groupItemTitle || ''));
  if (!m) return { token: null, note: 'piata negasita pe Polymarket' };
  const ids = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
  const outs = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
  const i = Math.max(0, (outs || []).findIndex(o => /over|yes/i.test(o)));
  return { token: ids?.[i] || null, note: null };
}
async function bookFor(token, pmaxC) {
  const b = await j(`${CLOB}/book?token_id=${token}`);
  const asks = (b.asks || []).map(a => ({ p: Number(a.price), s: Number(a.size) })).sort((x, y) => x.p - y.p);
  if (!asks.length) return null;
  const depth = asks.filter(a => a.p <= pmaxC / 100).reduce((t, a) => t + a.p * a.s, 0);
  return { ask: asks[0].p, depthAtOrBelowMax: depth };
}
// Telegram: variabilele pot sta in .env SAU in /root/.camera-telegram.env (supravietuieste deploy-ului GitHub Actions, care rescrie .env).
import { readFileSync } from 'fs';
function tgConf() {
  let t = process.env.TELEGRAM_BOT_TOKEN, c = process.env.TELEGRAM_CHAT_ID;
  if (!t || !c) {
    try {
      const f = Object.fromEntries(readFileSync('/root/.camera-telegram.env', 'utf8').split('\n').map(l => l.trim()).filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      t = t || f.TELEGRAM_BOT_TOKEN; c = c || f.TELEGRAM_CHAT_ID;
    } catch { /* fisier lipsa */ }
  }
  return { t, c };
}
export async function notify(text) {
  const { t, c } = tgConf();
  if (!t || !c) return false;
  try { const r = await fetch(`https://api.telegram.org/bot${t}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: c, text }) }); return r.ok; } catch { return false; }
}

async function main() {
  await ensureCameraTables();
  const s = await loadSettings();
  // 1) Decontare (mereu, chiar si cand e oprit)
  const done = await pool.query(`SELECT e.id, e.market, e.trigger_price, e.stake, h.home_goals, h.away_goals FROM camera_entries e JOIN fixtures_history h ON h.fixture_id = e.fixture_id
    WHERE e.status='triggered' AND e.result IS NULL AND h.status_short IN ('FT','AET','PEN') AND h.home_goals IS NOT NULL`);
  for (const r of done.rows) {
    const x = settle(r.market, r.home_goals, r.away_goals, Number(r.trigger_price), Number(r.stake));
    await pool.query("UPDATE camera_entries SET result=$2, pnl=$3, status='settled' WHERE id=$1", [r.id, x.result, x.pnl]);
  }
  // 2) Doar daca e START: evalueaza coada in ordine cronologica; ~55 s de polling la 5 s (prinde scaderile scurte de pret)
  if (!s.running) return console.log(`[alohapoly] ${new Date().toISOString()} STOP`);
  const st = (await pool.query(`SELECT COALESCE(SUM(stake) FILTER (WHERE triggered_at::date = CURRENT_DATE),0) AS spent, COALESCE(SUM(stake) FILTER (WHERE status='triggered'),0) AS open, COALESCE(SUM(pnl),0) AS pnl FROM camera_entries WHERE status IN ('triggered','settled')`)).rows[0];
  const streak = (await pool.query("SELECT result FROM camera_entries WHERE result IS NOT NULL ORDER BY triggered_at DESC LIMIT 50")).rows;
  let consecutiveLosses = 0; for (const r of streak) { if (r.result === 'loss') consecutiveLosses++; else break; }
  const ctx = { spentToday: Number(st.spent), freeBalance: s.bankroll + Number(st.pnl) - Number(st.open), consecutiveLosses };
  const tokens = new Map();   // cache slug|piata -> token (evita Gamma la fiecare 5 s)
  const startT = Date.now();
  do {
    const s2 = await loadSettings();
    if (!s2.running) break;
    const left = await tick(s2, ctx, tokens);
    if (!left) break;
    await new Promise(r => setTimeout(r, 5000));
  } while (Date.now() - startT < 52000);
}

// O trecere peste coada. Returneaza cate intrari au ramas in asteptare.
async function tick(s, ctx, tokens) {
  const waiting = (await pool.query("SELECT e.*, l.slug FROM camera_entries e LEFT JOIN polymarket_links l ON l.fixture_id = e.fixture_id WHERE e.status='waiting' ORDER BY e.kickoff ASC NULLS LAST, e.id")).rows;
  if (!waiting.length) return 0;
  // Minut real + scor din feed-ul live (scanner -> live_stats), doar daca e proaspat (< 3 min)
  const live = new Map((await pool.query(`SELECT DISTINCT ON (fixture_id) fixture_id, elapsed FROM live_stats WHERE fixture_id = ANY($1) AND recorded_at > now() - interval '3 minutes' ORDER BY fixture_id, recorded_at DESC`, [waiting.map(w => w.fixture_id)])).rows.map(r => [Number(r.fixture_id), r.elapsed]));
  for (const e of waiting) {
    try {
      const phase = entryPhase(e, new Date(), live.has(Number(e.fixture_id)) ? live.get(Number(e.fixture_id)) : null);
      if (phase === 'closed') { await pool.query("UPDATE camera_entries SET status='expired' WHERE id=$1", [e.id]); continue; }
      if (!e.slug) { await pool.query("UPDATE camera_entries SET note='fara link Polymarket' WHERE id=$1 AND note IS DISTINCT FROM 'fara link Polymarket'", [e.id]); continue; }
      const ck = e.slug + '|' + e.market;
      if (!tokens.has(ck)) tokens.set(ck, await marketToken(e.slug, e.market));
      const { token, note } = tokens.get(ck);
      if (!token) { await pool.query("UPDATE camera_entries SET note=$2 WHERE id=$1 AND note IS DISTINCT FROM $2", [e.id, note]); continue; }
      const book = await bookFor(token, e.pmax ?? s.pmax);
      await pool.query("UPDATE camera_entries SET last_price=$2, note=NULL WHERE id=$1", [e.id, book?.ask ?? null]);
      const d = evaluate(e, book, s, { ...ctx, spentOnMatch: 0 });
      if (!d.fire) continue;
      ctx.spentToday += d.stake; ctx.freeBalance -= d.stake;
      await pool.query("UPDATE camera_entries SET status='triggered', stake=$4, mode=$2, trigger_price=$3, triggered_at=now() WHERE id=$1", [e.id, s.mode, d.price, d.stake]);
      if (s.mode === 'alert') await notify(`AlohaPoly: ${e.match_label} · ${e.market} la ${Math.round(d.price * 100)}c (țintă ${e.pmin}-${e.pmax}c). Miză: ${d.stake} USDC. Decizia e a ta.`);
      console.log(`[alohapoly] declansat #${e.id} ${e.match_label} ${e.market} @${d.price} stake=${d.stake} mode=${s.mode}`);
    } catch (err) { console.error('[alohapoly] eroare intrare', e.id, err.message); }
  }
  return waiting.length;
}

if (process.argv[1] && process.argv[1].endsWith('camera-monitor.js')) {
  if (process.argv[2] === '--test-telegram') {
    notify('AlohaPoly: test Telegram OK. Alertele vor ajunge aici.').then(ok => { console.log(ok ? 'Telegram OK: mesaj trimis' : 'Telegram NEconfigurat sau respins (verifica token/chat id)'); pool.end(); });
  } else {
    main().then(() => pool.end()).catch(e => { console.error('[alohapoly] fatal', e.message); pool.end(); process.exit(1); });
  }
}
