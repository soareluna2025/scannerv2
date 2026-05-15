import pkg from 'pg'
const { Pool } = pkg
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL
})
export const query = (text, params) => pool.query(text, params)
export default pool
