// api/cron/cleanup-settings.js — curățare LUNARĂ app_settings (markeri bloat).
// GET /api/cron/cleanup-settings. Idempotent, silent-fail per pas.
//
// app_settings acumulează markeri operaționali cu cardinalitate uriașă:
//   - 'h2h_refresh:*'  → throttle 30 zile reconstrucție H2H (pur DB, fără API)
//   - 'no_data:*'      → fixturi fără date în API (evită re-apeluri)
// Cele 9 chei de CONFIG (fără prefix: backfill_*, extract_team_status, ...)
// NU sunt atinse — DELETE-urile sunt strict pe prefix.
import pool, { query } from '../db.js';

function log(msg) {
  console.log(`[cron/cleanup-settings] ${new Date().toISOString()} ${msg}`);
}

export default async function handler(req, res) {
  const t0 = Date.now();
  let h2hDeleted = 0, noDataDeleted = 0, vacuumOk = false;
  const errors = [];

  // 1. h2h_refresh:% — ștergere COMPLETĂ (sigur: doar recompute DB la nevoie).
  try {
    const r = await query(`DELETE FROM app_settings WHERE key LIKE 'h2h_refresh:%'`);
    h2hDeleted = r.rowCount || 0;
    log(`h2h_refresh șterse: ${h2hDeleted}`);
  } catch (e) { errors.push(`h2h: ${e.message}`); log(`h2h error: ${e.message}`); }

  // 2. no_data:% mai vechi de 90 zile (markerii recenți rămân → fără re-apel API).
  try {
    const r = await query(
      `DELETE FROM app_settings
        WHERE key LIKE 'no_data:%' AND updated_at < NOW() - INTERVAL '90 days'`
    );
    noDataDeleted = r.rowCount || 0;
    log(`no_data (>90z) șterse: ${noDataDeleted}`);
  } catch (e) { errors.push(`no_data: ${e.message}`); log(`no_data error: ${e.message}`); }

  // 3. VACUUM ANALYZE — pool.query DIRECT (NU în tranzacție; VACUUM nu rulează
  //    într-un bloc tranzacțional).
  // 2b. api_markers (tabelul nou): no_data:% >90 zile, h2h_refresh >30 zile.
  let markersDeleted = 0;
  try {
    const r1 = await query(`DELETE FROM api_markers WHERE kind LIKE 'no_data:%' AND created_at < NOW() - INTERVAL '90 days'`);
    const r2 = await query(`DELETE FROM api_markers WHERE kind = 'h2h_refresh' AND created_at < NOW() - INTERVAL '30 days'`);
    markersDeleted = (r1.rowCount || 0) + (r2.rowCount || 0);
    log(`api_markers șterse: ${markersDeleted}`);
  } catch (e) { errors.push(`api_markers: ${e.message}`); log(`api_markers error: ${e.message}`); }

  try {
    await pool.query(`VACUUM ANALYZE app_settings`);
    await pool.query(`VACUUM ANALYZE api_markers`).catch(() => {});
    vacuumOk = true;
    log(`VACUUM ANALYZE app_settings + api_markers OK`);
  } catch (e) { errors.push(`vacuum: ${e.message}`); log(`vacuum error: ${e.message}`); }

  // 4. cron_logs — status 'ok' + rezumat per tip în error_msg (singurul câmp text).
  const summary = `h2h_refresh=${h2hDeleted} no_data_90d=${noDataDeleted} vacuum=${vacuumOk}`
    + (errors.length ? ` | errors: ${errors.join('; ')}` : '');
  try {
    await Promise.resolve(/* cron_logs → dispecer */);
  } catch (e) { log(`cron_logs error: ${e.message}`); }

  res.status(200).json({
    ok: true,
    h2h_refresh_deleted: h2hDeleted,
    no_data_90d_deleted: noDataDeleted,
    vacuum: vacuumOk,
    errors,
    duration_ms: Date.now() - t0,
  });
}
