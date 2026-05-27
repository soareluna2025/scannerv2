// Endpoint public lightweight care returneaza listele de ligi 'good' si 'bad'
// pe baza Over 1.5 win rate-ului real din ultimele 30 zile.
//
// Folosit de frontend main app pentru a marca cardurile live cu badge-uri:
//   - GOOD: WR >= 75% si n >= 5 → border + badge verde
//   - BAD : WR <= 50% si n >= 5 → border + badge rosu
//
// GET /api/learning-leagues
//   ?days=30 (default), ?minN=5 (default)
//   ?minWR=75 (default for good), ?maxWR=50 (default for bad)
//
// Response: { ok, good: [{id,name,n,wr}], bad: [{id,name,n,wr}] }

import { query } from './db.js';

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 5 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const days  = Math.min(parseInt(req.query?.days  || '30', 10), 365);
  const minN  = Math.max(parseInt(req.query?.minN  || '5',  10), 1);
  const minWR = Math.max(parseInt(req.query?.minWR || '75', 10), 50);
  const maxWR = Math.min(parseInt(req.query?.maxWR || '50', 10), 75);

  const isDefault = days === 30 && minN === 5 && minWR === 75 && maxWR === 50;
  if (isDefault && _cache && Date.now() - _cacheTs < CACHE_TTL) {
    return res.status(200).json({ ok: true, cached: true, ..._cache });
  }

  try {
    // 1. Overall stats — pentru banner-ul scanner "Over 1.5 win rate"
    // Filtru over15_prob >= 60: masuram precizia modelului cand a prezis activ Over 1.5,
    // nu rata naturala a fotbalului (care e ~77% indiferent de model)
    const { rows: ovRows } = await query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE result_over15 = TRUE)::int  AS wins,
        COUNT(*) FILTER (WHERE result_over15 = FALSE)::int AS losses,
        COUNT(*) FILTER (WHERE result_over15 IS NULL)::int AS pending
      FROM predictions
      WHERE created_at > NOW() - (INTERVAL '1 day' * $1)
        AND over15_prob >= 60
    `, [days]);
    const ov = ovRows[0] || { total: 0, wins: 0, losses: 0, pending: 0 };
    const resolved = Number(ov.wins) + Number(ov.losses);
    const overall = {
      total:    Number(ov.total),
      wins:     Number(ov.wins),
      losses:   Number(ov.losses),
      pending:  Number(ov.pending),
      resolved,
      winRate:  resolved > 0 ? Math.round(Number(ov.wins) / resolved * 100) : null,
    };

    // 2. Per-league stats — pentru badge-uri good/bad
    // Acelasi filtru over15_prob >= 60: badge-ul verde/rosu reflecta
    // precizia modelului pe acea liga, nu rata naturala de goluri
    const { rows } = await query(`
      SELECT
        league_id,
        league_name,
        COUNT(*)::int AS n,
        COUNT(*) FILTER (WHERE result_over15 = TRUE)::int AS wins,
        ROUND(100.0 * COUNT(*) FILTER (WHERE result_over15 = TRUE) / NULLIF(COUNT(*), 0), 1) AS wr
      FROM predictions
      WHERE created_at > NOW() - (INTERVAL '1 day' * $1)
        AND result_over15 IS NOT NULL
        AND over15_prob >= 60
        AND league_id IS NOT NULL
      GROUP BY league_id, league_name
      HAVING COUNT(*) >= $2
      ORDER BY wr DESC NULLS LAST
    `, [days, minN]);

    const good = [];
    const bad  = [];
    for (const r of rows) {
      const wr = r.wr === null ? 0 : Number(r.wr);
      const entry = {
        id:   Number(r.league_id),
        name: r.league_name,
        n:    Number(r.n),
        wins: Number(r.wins),
        wr,
      };
      if (wr >= minWR) good.push(entry);
      else if (wr <= maxWR) bad.push(entry);
    }

    const result = { overall, good, bad };
    if (isDefault) {
      _cache = result;
      _cacheTs = Date.now();
    }

    return res.status(200).json({ ok: true, cached: false, ...result });
  } catch (e) {
    console.error('[learning-leagues]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
