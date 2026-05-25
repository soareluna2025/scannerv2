#!/usr/bin/env node
// Collect Coaches — fetch antrenori per echipă din API-Football și salvează în DB
//
// Pentru fiecare echipă fără antrenor în DB, fetch /coachs?team=X.
// API returnează: id, name, age, nationality, career array (echipe + start/end).
//
// Rulare pe VPS:
//   node scripts/collect-coaches.js                   # default limit 200
//   node scripts/collect-coaches.js --limit 500
//   node scripts/collect-coaches.js --limit 50 --dry  # nu scrie în DB
//
// Cost API: ~1 call per echipă (one-time pentru echipe noi)

// ── Auto-load .env ────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname_ = dirname(fileURLToPath(import.meta.url));

const envCandidates = [
  join(__dirname_, '..', '.env'),
  resolve(process.cwd(), '.env'),
  '/root/scannerv2/.env',
];
for (const p of envCandidates) {
  if (existsSync(p)) {
    for (let line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      line = line.replace(/^\s*export\s+/, '');
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (!process.env[key]) process.env[key] = val;
    }
    break;
  }
}

if (!process.env.POSTGRES_URL) {
  console.error('❌ POSTGRES_URL nu este setat. Rulează din /root/scannerv2/');
  process.exit(1);
}
if (!(process.env.API_FOOTBALL_KEY || process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY)) {
  console.error('❌ API_FOOTBALL_KEY nu este setat în .env');
  process.exit(1);
}

import pkg from 'pg';
const { Pool } = pkg;
const dbUrl = new URL(process.env.POSTGRES_URL);
const pool = new Pool({
  host: dbUrl.hostname,
  port: parseInt(dbUrl.port) || 5432,
  user: decodeURIComponent(dbUrl.username),
  password: decodeURIComponent(dbUrl.password),
  database: dbUrl.pathname.replace(/^\//, ''),
});
const query = (t, p) => pool.query(t, p);

import { fetchApiFootball } from '../api/utils/fetch-api.js';

// ── Args ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const limit = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : 200;
})();
const dryRun = args.includes('--dry');

// ── Schema bootstrap ──────────────────────────────────────────
async function ensureColumns() {
  await query(`ALTER TABLE coaches ADD COLUMN IF NOT EXISTS photo TEXT`).catch(() => {});
  await query(`ALTER TABLE coaches ADD COLUMN IF NOT EXISTS birth_date DATE`).catch(() => {});
  await query(`ALTER TABLE coaches ADD COLUMN IF NOT EXISTS birth_place TEXT`).catch(() => {});
  await query(`ALTER TABLE coaches ADD COLUMN IF NOT EXISTS birth_country TEXT`).catch(() => {});
  await query(`ALTER TABLE coaches ADD COLUMN IF NOT EXISTS height TEXT`).catch(() => {});
  await query(`ALTER TABLE coaches ADD COLUMN IF NOT EXISTS weight TEXT`).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS coach_career (
      id           SERIAL PRIMARY KEY,
      coach_id     INT NOT NULL,
      team_id      INT,
      team_name    TEXT,
      start_date   DATE,
      end_date     DATE,
      UNIQUE (coach_id, team_id, start_date)
    )
  `).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_coach_career_coach ON coach_career(coach_id)`).catch(() => {});
}

// ── Save one team's coaches ───────────────────────────────────
async function collectOne(teamId, teamName) {
  try {
    const r = await fetchApiFootball(`/coachs?team=${teamId}`);
    const d = await r.json();
    const items = d.response || [];
    if (!items.length) return { team_id: teamId, team_name: teamName, coaches_found: 0 };

    let saved = 0;
    for (const c of items) {
      if (!c.id) continue;
      if (dryRun) { saved++; continue; }

      await query(`
        INSERT INTO coaches (coach_id, team_id, team_name, name, firstname, lastname, nationality, age, photo, birth_date, birth_place, birth_country, height, weight, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
        ON CONFLICT (coach_id, team_id) DO UPDATE SET
          name = EXCLUDED.name,
          firstname = EXCLUDED.firstname,
          lastname = EXCLUDED.lastname,
          nationality = EXCLUDED.nationality,
          age = EXCLUDED.age,
          photo = EXCLUDED.photo,
          birth_date = EXCLUDED.birth_date,
          birth_place = EXCLUDED.birth_place,
          birth_country = EXCLUDED.birth_country,
          height = EXCLUDED.height,
          weight = EXCLUDED.weight,
          updated_at = NOW()
      `, [
        c.id, teamId, teamName, c.name || null, c.firstname || null, c.lastname || null,
        c.nationality || null, c.age || null, c.photo || null,
        c.birth?.date || null, c.birth?.place || null, c.birth?.country || null,
        c.height || null, c.weight || null,
      ]).catch(e => console.warn(`[coaches] insert ${c.id}: ${e.message}`));
      saved++;

      const career = c.career || [];
      for (const ent of career) {
        await query(`
          INSERT INTO coach_career (coach_id, team_id, team_name, start_date, end_date)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (coach_id, team_id, start_date) DO UPDATE SET
            end_date = EXCLUDED.end_date
        `, [
          c.id, ent.team?.id || null, ent.team?.name || null,
          ent.start || null, ent.end || null,
        ]).catch(() => {});
      }
    }
    return { team_id: teamId, team_name: teamName, coaches_found: saved };
  } catch (e) {
    console.warn(`[coaches] team ${teamId}: ${e.message}`);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log(`[collect-coaches] start | limit=${limit}${dryRun ? ' DRY-RUN' : ''}`);
  await ensureColumns();

  const { rows: teams } = await query(`
    SELECT team_id, name FROM teams
    WHERE team_id NOT IN (SELECT DISTINCT team_id FROM coaches WHERE team_id IS NOT NULL)
    ORDER BY team_id
    LIMIT $1
  `, [limit]);

  console.log(`[collect-coaches] echipe fără antrenor: ${teams.length}`);

  const collected = [];
  let processed = 0;
  for (const t of teams) {
    const out = await collectOne(t.team_id, t.name);
    if (out) collected.push(out);
    processed++;
    if (processed % 25 === 0) {
      console.log(`[collect-coaches] progres ${processed}/${teams.length}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  if (!dryRun) {
    await query(`
      INSERT INTO cron_logs (job_name, ran_at, status, fixtures_processed)
      VALUES ('collect-coaches', NOW(), 'success', $1)
    `, [collected.length]).catch(() => {});
  }

  const { rows: totalRows } = await query(`
    SELECT COUNT(DISTINCT coach_id)::int AS coaches, COUNT(*)::int AS rows
    FROM coaches
  `).catch(() => ({ rows: [{ coaches: 0, rows: 0 }] }));

  const totalCoachesFound = collected.reduce((s, c) => s + (c.coaches_found || 0), 0);
  console.log(`[collect-coaches] DONE`);
  console.log(`  teams_processed       : ${teams.length}`);
  console.log(`  teams_with_response   : ${collected.length}`);
  console.log(`  coaches_saved_total   : ${totalCoachesFound}${dryRun ? ' (dry-run, not written)' : ''}`);
  console.log(`  db_unique_coaches     : ${totalRows[0]?.coaches || 0}`);
  console.log(`  db_coach_rows         : ${totalRows[0]?.rows || 0}`);

  await pool.end();
}

main().catch(e => {
  console.error('[collect-coaches] FATAL:', e.message);
  pool.end().finally(() => process.exit(1));
});
