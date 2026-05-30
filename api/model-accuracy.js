// GET /api/model-accuracy
// Acuratețea REALĂ a modelului din prediction_log (single source of truth),
// pe module: OVER15, GG, NGP, CONFIDENCE. Înlocuiește vechea bară win-rate
// care măsura base-rate-ul fotbalului (over15_prob>=60 < ~77% natural).
//
// Query:
//   ?days=30|60|90   (default 30)
//   ?minConf=80|0     (default 80 = doar predicții „convinse"; 0 = toate)
//
// Response: { ok, period, minConf, overall, breakdown:{over15,gg,ngp,confidence},
//             total_resolved, total_pending }

import { query } from './db.js';

const _cache = new Map();           // key: `${days}-${conf}`
const CACHE_TTL = 10 * 60 * 1000;   // 10 min
const MODULES = ['OVER15', 'GG', 'NGP', 'CONFIDENCE'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const dRaw = parseInt(req.query?.days, 10);
  const days = [30, 60, 90].includes(dRaw) ? dRaw : 30;
  // minConf=0 → „toate predicțiile"; altfel pragul „convinse" = 80.
  const conf = (parseInt(req.query?.minConf, 10) === 0) ? 0 : 80;

  const cacheKey = `${days}-${conf}`;
  const c = _cache.get(cacheKey);
  if (c && Date.now() - c.ts < CACHE_TTL) {
    return res.status(200).json({ ...c.data, cached: true });
  }

  try {
    const { rows } = await query(`
      SELECT module,
        COUNT(*) FILTER (WHERE outcome='WIN')::int     AS wins,
        COUNT(*) FILTER (WHERE outcome='LOSS')::int    AS losses,
        COUNT(*) FILTER (WHERE outcome='PENDING')::int AS pending
      FROM prediction_log
      WHERE created_at > NOW() - (INTERVAL '1 day' * $1)
        AND predicted_value >= $2
        AND module = ANY($3)
      GROUP BY module
    `, [days, conf, MODULES]);

    const byMod = {};
    for (const r of rows) byMod[r.module] = r;

    const mk = (m) => {
      const r = byMod[m] || {};
      const wins = Number(r.wins) || 0;
      const losses = Number(r.losses) || 0;
      const pending = Number(r.pending) || 0;
      const resolved = wins + losses;
      return { wins, losses, pending, resolved, winRate: resolved > 0 ? Math.round(wins / resolved * 100) : null };
    };

    const breakdown = {
      over15:     mk('OVER15'),
      gg:         mk('GG'),
      ngp:        mk('NGP'),
      confidence: mk('CONFIDENCE'),
    };

    // overall = agregat peste toate modulele filtrate
    let W = 0, L = 0, P = 0;
    for (const k of Object.keys(breakdown)) {
      W += breakdown[k].wins; L += breakdown[k].losses; P += breakdown[k].pending;
    }
    const resolvedAll = W + L;
    const overall = {
      wins: W, losses: L, pending: P, resolved: resolvedAll,
      winRate: resolvedAll > 0 ? Math.round(W / resolvedAll * 100) : null,
    };

    const data = {
      ok: true,
      period: days,
      minConf: conf,
      overall,
      breakdown,
      total_resolved: resolvedAll,
      total_pending: P,
    };
    _cache.set(cacheKey, { data, ts: Date.now() });
    return res.status(200).json({ ...data, cached: false });
  } catch (e) {
    console.error('[model-accuracy]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
