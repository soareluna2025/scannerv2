// GET /api/model-accuracy
// Acuratețea REALĂ a modelului din tabela `predictions` (1 înregistrare per meci),
// NU din prediction_log (care are sute de mii de rânduri — scanner scrie la 2s,
// inflama artificial procentul). Sursa corectă = meciuri verificate, unice.
//
// Query: ?days=30|60|90 (default 30)
//
// Response: { ok, source:'predictions', period, total_resolved,
//             by_confidence:{high,mid,low,very_low}, main_accuracy, main_total,
//             base_rate, gg_main, gg_base_rate, model_adds_value }

import { query } from './db.js';

const _cache = new Map();           // key: days
const CACHE_TTL = 10 * 60 * 1000;   // 10 min

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const dRaw = parseInt(req.query?.days, 10);
  const days = [30, 60, 90].includes(dRaw) ? dRaw : 30;

  const c = _cache.get(days);
  if (c && Date.now() - c.ts < CACHE_TTL) {
    return res.status(200).json({ ...c.data, cached: true });
  }

  try {
    // Per nivel de confidence — 1 rând per meci, doar meciuri cu rezultat verificat.
    const { rows } = await query(`
      SELECT
        CASE
          WHEN confidence >= 80 THEN 'high'
          WHEN confidence >= 70 THEN 'mid'
          WHEN confidence >= 60 THEN 'low'
          ELSE 'very_low'
        END AS nivel,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE result_over15 = TRUE)::int  AS over15_win,
        COUNT(*) FILTER (WHERE result_over15 = FALSE)::int AS over15_loss,
        COUNT(*) FILTER (WHERE result_gg = TRUE)::int      AS gg_win,
        COUNT(*) FILTER (WHERE result_gg = FALSE)::int     AS gg_loss,
        ROUND(AVG(over15_prob)::numeric, 1) AS avg_predicted,
        ROUND(COUNT(*) FILTER (WHERE result_over15 = TRUE)::numeric /
          NULLIF(COUNT(*) FILTER (WHERE result_over15 IS NOT NULL), 0) * 100, 1) AS over15_accuracy,
        ROUND(COUNT(*) FILTER (WHERE result_gg = TRUE)::numeric /
          NULLIF(COUNT(*) FILTER (WHERE result_gg IS NOT NULL), 0) * 100, 1) AS gg_accuracy
      FROM predictions
      WHERE result_over15 IS NOT NULL
        AND confidence IS NOT NULL
        AND updated_at >= NOW() - (INTERVAL '1 day' * $1)
      GROUP BY 1
    `, [days]);

    const byLvl = {};
    for (const r of rows) byLvl[r.nivel] = r;

    const mk = (lvl) => {
      const r = byLvl[lvl] || {};
      return {
        total:           Number(r.total) || 0,
        over15_accuracy: r.over15_accuracy != null ? Number(r.over15_accuracy) : null,
        gg_accuracy:     r.gg_accuracy != null ? Number(r.gg_accuracy) : null,
        avg_predicted:   r.avg_predicted != null ? Number(r.avg_predicted) : null,
      };
    };
    const by_confidence = {
      high:     mk('high'),
      mid:      mk('mid'),
      low:      mk('low'),
      very_low: mk('very_low'),
    };

    // Agregat helper peste o listă de niveluri (din rândurile brute).
    const agg = (levels) => {
      let total = 0, o15w = 0, o15n = 0, ggw = 0, ggn = 0, predSum = 0, predN = 0;
      for (const lvl of levels) {
        const r = byLvl[lvl]; if (!r) continue;
        const t = Number(r.total) || 0;
        const w = Number(r.over15_win) || 0, l = Number(r.over15_loss) || 0;
        const gw = Number(r.gg_win) || 0, gl = Number(r.gg_loss) || 0;
        total += t; o15w += w; o15n += (w + l); ggw += gw; ggn += (gw + gl);
        if (r.avg_predicted != null) { predSum += Number(r.avg_predicted) * t; predN += t; }
      }
      return {
        total,
        over15_accuracy: o15n > 0 ? Math.round(o15w / o15n * 1000) / 10 : null,
        gg_accuracy:     ggn > 0 ? Math.round(ggw / ggn * 1000) / 10 : null,
        avg_predicted:   predN > 0 ? Math.round(predSum / predN * 10) / 10 : null,
      };
    };

    const main = agg(['high', 'mid']);            // confidence >= 70 = predicții „convinse"
    const all  = agg(['high', 'mid', 'low', 'very_low']); // benchmark = rata de bază

    const main_accuracy = main.over15_accuracy;
    const base_rate     = all.over15_accuracy;
    const model_adds_value = (main_accuracy != null && base_rate != null)
      ? (main_accuracy > base_rate + 2) : false;

    const data = {
      ok: true,
      source: 'predictions',
      period: days,
      total_resolved: all.total,
      by_confidence,
      main_accuracy,
      main_total: main.total,
      base_rate,
      gg_main: main.gg_accuracy,
      gg_base_rate: all.gg_accuracy,
      model_adds_value,
    };
    _cache.set(days, { data, ts: Date.now() });
    return res.status(200).json({ ...data, cached: false });
  } catch (e) {
    console.error('[model-accuracy]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
