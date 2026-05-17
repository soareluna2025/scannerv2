import pkg from 'pg'
const { Pool } = pkg
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL
})
pool.on('error', (err) => {
  console.error('[db] Idle client error:', err.message);
})
export const query = (text, params) => pool.query(text, params)
export default pool
