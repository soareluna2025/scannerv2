// api/utils/cron-log.js — logging UNIFORM pentru cron-uri. Repară „orbirea":
// fiecare execuție scrie un rând în cron_logs (job_name, ran_at, duration_ms,
// status 'ok'|'idle'|'error', items_processed). NU atinge logica joburilor —
// e doar învelișul de logging, apelat din dispatcher-ul cron din server.js
// (și opțional din interiorul unui job pentru status 'idle'/items reali).
import { query } from '../db.js';

// Adaugă idempotent coloanele necesare (cron_logs are deja status/duration_ms).
export async function ensureCronLogColumns() {
  try { await query(`ALTER TABLE cron_logs ADD COLUMN IF NOT EXISTS items_processed INTEGER`); } catch (_) {}
}

// Fire-and-forget — nu blochează răspunsul cron-ului.
export function logCronRun(jobName, startMs, opts = {}) {
  const { status = 'ok', items = null, error = null } = opts;
  const dur = Date.now() - (startMs || Date.now());
  query(
    `INSERT INTO cron_logs (job_name, ran_at, duration_ms, status, items_processed, error_msg)
     VALUES ($1, NOW(), $2, $3, $4, $5)`,
    [jobName, dur, status, items, error ? String(error).slice(0, 500) : null]
  ).catch(() => {});
}
