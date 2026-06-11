// api/cron/optimize-db.js — OPTIMIZARE DB rapidă: VACUUM (ANALYZE) pe tabelele
// mari/active. ATENȚIE: VACUUM nu poate rula în tranzacție → folosim o conexiune
// DEDICATĂ din pool și query-uri individuale, FĂRĂ BEGIN. Returnează durata/tabel.
// NU atinge scoring/enrich/score1-7. Doar întreținere (autocommit).
import pool from '../db.js';

// Tabele țintă (allowlist FIXĂ — fără input de la user → fără injection).
const RAPID_TABLES = [
  'fixtures_history', 'match_events', 'match_stats', 'odds', 'predictions',
  'prediction_log', 'player_stats', 'h2h', 'standings', 'live_stats',
  'ml_features', 'fixtures',
];

export default async function handler(req, res) {
  const mode = (req.query?.mode || req.body?.mode || 'rapid').toString();
  if (mode !== 'rapid') {
    return res.status(400).json({ ok: false, error: 'mode invalid (doar "rapid" în Faza 1)' });
  }
  const t0 = Date.now();
  const client = await pool.connect();   // conexiune dedicată, autocommit (fără BEGIN)
  const results = [];
  try {
    for (const t of RAPID_TABLES) {
      const s = Date.now();
      try {
        // VACUUM ANALYZE pe nume din allowlist (nu din input) → sigur.
        await client.query(`VACUUM (ANALYZE) ${t}`);
        results.push({ table: t, ms: Date.now() - s, ok: true });
      } catch (e) {
        results.push({ table: t, ms: Date.now() - s, ok: false, error: e.message });
      }
    }
  } finally {
    client.release();
  }
  res.json({
    ok: true,
    mode,
    total_ms: Date.now() - t0,
    tables: results.length,
    results,
    finished_at: new Date().toISOString(),
  });
}
