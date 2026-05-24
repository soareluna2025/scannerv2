// Endpoint public care returneaza tabela de calibrare actualizata din DB
// (generata de cron-ul recalibrate-tables). Frontend o foloseste pentru
// G2_CALIBRATION dinamica in loc de hardcoded.
//
// GET /api/calibration
// Response: { ok: true, generated_at, modules: {moduleKey: {buckets, n, brier}} }

import { query } from './db.js';

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 10 * 60 * 1000;  // 10 min

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (_cache && Date.now() - _cacheTs < CACHE_TTL) {
    return res.status(200).json({ ok: true, cached: true, ..._cache });
  }

  try {
    const { rows } = await query(`
      SELECT module, buckets, sample_size, brier_score, generated_at
      FROM calibration_tables
      ORDER BY module
    `).catch(() => ({ rows: [] }));

    const modules = {};
    for (const r of rows) {
      modules[r.module] = {
        buckets:  r.buckets,  // already JSONB
        n:        Number(r.sample_size || 0),
        brier:    r.brier_score ? Number(r.brier_score) : null,
        updated:  r.generated_at,
      };
    }

    const result = {
      generated_at: rows.length ? rows[0].generated_at : null,
      modules,
    };
    _cache = result;
    _cacheTs = Date.now();

    return res.status(200).json({ ok: true, cached: false, ...result });
  } catch (e) {
    console.error('[calibration]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
