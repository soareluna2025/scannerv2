// Endpoint public lightweight care returneaza lista de ligi 'good'
// (cele cu win rate ridicat pe Over 1.5 in ultimele 30 zile).
//
// Folosit de frontend main app pentru a marca cardurile live cu badge
// vizual cand meciul e intr-o liga cu performanta dovedita.
//
// GET /api/learning-leagues
//   ?days=30 (default), ?minWR=75 (default), ?minN=5 (default)
//
// Response: { ok: true, leagues: [{id, name, n, wr}, ...] }

import { query } from './db.js';

// Cache rezultatul pentru a evita query repetate (5 min)
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 5 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const days  = Math.min(parseInt(req.query?.days  || '30', 10), 365);
  const minWR = Math.max(parseInt(req.query?.minWR || '75', 10), 50);
  const minN  = Math.max(parseInt(req.query?.minN  || '5',  10), 1);

  // Cache hit: returnam dacă parametrii sunt default si TTL nu a expirat
  const isDefault = days === 30 && minWR === 75 && minN === 5;
  if (isDefault && _cache && Date.now() - _cacheTs < CACHE_TTL) {
    return res.status(200).json({ ok: true, cached: true, leagues: _cache });
  }

  try {
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
        AND league_id IS NOT NULL
      GROUP BY league_id, league_name
      HAVING COUNT(*) >= $2
        AND (100.0 * COUNT(*) FILTER (WHERE result_over15 = TRUE) / NULLIF(COUNT(*), 0)) >= $3
      ORDER BY wr DESC NULLS LAST
      LIMIT 100
    `, [days, minN, minWR]);

    const leagues = rows.map(r => ({
      id:   Number(r.league_id),
      name: r.league_name,
      n:    Number(r.n),
      wins: Number(r.wins),
      wr:   r.wr === null ? 0 : Number(r.wr),
    }));

    if (isDefault) {
      _cache = leagues;
      _cacheTs = Date.now();
    }

    return res.status(200).json({ ok: true, cached: false, leagues });
  } catch (e) {
    console.error('[learning-leagues]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
