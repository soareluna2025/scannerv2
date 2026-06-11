// api/utils/markers.js — markeri operaționali API în tabel DEDICAT `api_markers`
// (kind, ref_key, created_at), NU în app_settings (care creștea la 763k rânduri).
// kind ∈ {'no_data:stats','no_data:events','no_data:players','h2h_refresh'}.
// ref_key = id-ul/cheia (ex. fixture_id, 'teamId:season', 'team1:team2').
// Silent-fail peste tot → un marker pierdut doar declanșează o re-verificare API.
import { query } from '../db.js';

export async function ensureMarkerTable() {
  try {
    await query(`CREATE TABLE IF NOT EXISTS api_markers (
      kind        TEXT NOT NULL,
      ref_key     TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (kind, ref_key)
    )`);
  } catch (_) { /* ignore */ }
}

export async function setMarker(kind, ref) {
  try {
    await query(
      `INSERT INTO api_markers (kind, ref_key) VALUES ($1, $2)
         ON CONFLICT (kind, ref_key) DO UPDATE SET created_at = NOW()`,
      [kind, String(ref)]
    );
  } catch (_) { /* ignore */ }
}

export async function hasMarker(kind, ref) {
  try {
    const r = await query(
      `SELECT 1 FROM api_markers WHERE kind = $1 AND ref_key = $2`, [kind, String(ref)]);
    return (r.rowCount || 0) > 0;
  } catch (_) { return false; }
}

// True dacă markerul există ȘI e mai NOU de `days` zile (throttle, ex. h2h_refresh 30z).
export async function isMarkerFresh(kind, ref, days) {
  try {
    const r = await query(
      `SELECT 1 FROM api_markers
         WHERE kind = $1 AND ref_key = $2
           AND created_at > NOW() - ($3 || ' days')::interval`,
      [kind, String(ref), String(days)]);
    return (r.rowCount || 0) > 0;
  } catch (_) { return false; }
}

// Set de ref_key existente pentru un kind, dintr-o listă (filtrare în bulk).
export async function markersForKind(kind, refs) {
  try {
    const r = await query(
      `SELECT ref_key FROM api_markers WHERE kind = $1 AND ref_key = ANY($2)`,
      [kind, refs.map(String)]);
    return new Set(r.rows.map(x => x.ref_key));
  } catch (_) { return new Set(); }
}
