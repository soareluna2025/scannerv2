// scripts/audit-leagues.js — AUDIT whitelist ligi vs realitate (tabela leagues + predictions).
// Pentru FIECARE ID din ALLOWED_LEAGUE_IDS: nume real + țară (din leagues), count(predictions),
// max(created_at), marcaj DEAD (nu există în leagues) / ZERO (există dar 0 predicții).
// Rulare pe VPS:  node scripts/audit-leagues.js
// (Sandbox-ul n-are DB — se rulează pe VPS. Citește POSTGRES_URL din .env.)

import { ALLOWED_LEAGUE_IDS } from '../api/leagues.js';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv(p) {
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch (_) { /* .env opțional */ }
}
loadEnv('/root/scannerv2/.env');
loadEnv(path.join(__dirname, '..', '.env'));

const connStr = process.env.POSTGRES_URL ||
  `postgresql://${process.env.PGUSER || 'alohascan'}:${process.env.PGPASSWORD || ''}@${process.env.PGHOST || '127.0.0.1'}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'elefant'}`;

function pad(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n); }
function padL(s, n) { s = String(s == null ? '' : s); return s.padStart(n); }

(async () => {
  const c = new pg.Client({ connectionString: connStr });
  await c.connect();
  const ids = [...ALLOWED_LEAGUE_IDS];
  const rows = [];
  for (const id of ids) {
    const lg = await c.query('SELECT name, country FROM leagues WHERE league_id = $1', [id]).catch(() => ({ rows: [] }));
    const pr = await c.query('SELECT COUNT(*)::int AS n, MAX(created_at) AS m FROM predictions WHERE league_id = $1', [id]).catch(() => ({ rows: [{ n: 0, m: null }] }));
    const inLeagues = lg.rows.length > 0;
    const n = pr.rows[0]?.n || 0;
    const flag = !inLeagues ? 'DEAD' : (n === 0 ? 'ZERO' : '');
    rows.push({
      id,
      country: inLeagues ? (lg.rows[0].country || '?') : '(DEAD)',
      name: inLeagues ? (lg.rows[0].name || '?') : '(nu există în leagues)',
      n,
      last: pr.rows[0]?.m ? new Date(pr.rows[0].m).toISOString().slice(0, 10) : '—',
      flag,
    });
  }
  await c.end();

  rows.sort((a, b) => (a.country || '').localeCompare(b.country || '') || (b.n - a.n) || (a.id - b.id));
  console.log('\n' + pad('ID', 7) + pad('NAME', 44) + padL('PRED', 7) + '  ' + pad('LAST_PRED', 12) + 'FLAG');
  console.log('─'.repeat(78));
  let cur = null;
  for (const r of rows) {
    if (r.country !== cur) { console.log('\n── ' + r.country + ' ' + '─'.repeat(Math.max(0, 50 - r.country.length))); cur = r.country; }
    console.log(pad(r.id, 7) + pad(r.name, 44) + padL(r.n, 7) + '  ' + pad(r.last, 12) + (r.flag || ''));
  }
  const dead = rows.filter(r => r.flag === 'DEAD').map(r => r.id);
  const zero = rows.filter(r => r.flag === 'ZERO').map(r => r.id);
  console.log('\n' + '═'.repeat(78));
  console.log(`TOTAL: ${rows.length} ligi în whitelist`);
  console.log(`DEAD (${dead.length}) [nu există în leagues]: ${dead.join(', ') || '—'}`);
  console.log(`ZERO (${zero.length}) [există dar 0 predicții]: ${zero.join(', ') || '—'}`);
})().catch(e => { console.error('EROARE audit:', e.message); process.exit(1); });
