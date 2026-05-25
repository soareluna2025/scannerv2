import pkg from 'pg'
const { Pool } = pkg
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL
})
pool.on('error', (err) => {
  console.error('[db] Idle client error:', err.message);
})
export const query = (text, params) => pool.query(text, params)

// Helper: logheaza eroare in cron_logs (vizibila in admin -> Erori Recente)
// Folosit din ORICE endpoint, nu doar cron-uri
export async function logError(jobName, errorMsg) {
  try {
    await pool.query(
      `INSERT INTO cron_logs (job_name, ran_at, status, error_msg) VALUES ($1, NOW(), 'error', $2)`,
      [jobName, String(errorMsg).slice(0, 1000)]
    );
  } catch (_) { /* ignore — daca nu putem loga, nu vrem cascada */ }
}

export default pool
