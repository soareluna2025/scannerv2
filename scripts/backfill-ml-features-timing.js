#!/usr/bin/env node
// scripts/backfill-ml-features-timing.js — RE-MATERIALIZARE NON-destructivă a celor 12
// coloane „timing goluri" pe rândurile ml_features EXISTENTE (opțiunea b).
//
// • Folosește EXACT timingBody din api/utils/goal-timing-sql.js (sursă canonică) → aceeași
//   fereastră K=20, point-in-time (match_date STRICT <), aceleași filtre/own-goal/NULL ca 2a/2b.
// • UPDATE ... FROM fixtures_history + LATERAL — umple DOAR cele 12 coloane timing.
//   NU TRUNCATE, NU șterge, NU atinge celelalte coloane. (Rândurile fără fixtures_history
//   sau cu <5 meciuri anterioare rămân NULL — corect.)
// • Idempotent / reluabil: cursor pe fixture_id în app_settings('backfill_mlf_timing_cursor').
//   Re-rulare = continuă; `--reset` = reia de la 0 (recalcul determinist, aceleași valori).
//
// Rulare pe VPS:  node scripts/backfill-ml-features-timing.js [--reset] [--batch=2000]
import 'dotenv/config';
import { query } from '../api/db.js';
import pool from '../api/db.js';
import { timingBody } from '../api/utils/goal-timing-sql.js';

const RESET = process.argv.includes('--reset');
const BATCH = parseInt((process.argv.find(a => a.startsWith('--batch=')) || '--batch=2000').slice(8), 10) || 2000;
const CURSOR_KEY = 'backfill_mlf_timing_cursor';

const UPDATE_SQL = `
UPDATE ml_features mf
SET home_tm_scored_r2_share     = tmh.tm_scored_r2_share,
    away_tm_scored_r2_share     = tma.tm_scored_r2_share,
    home_tm_conceded_r2_share   = tmh.tm_conceded_r2_share,
    away_tm_conceded_r2_share   = tma.tm_conceded_r2_share,
    home_tm_scored_late_share   = tmh.tm_scored_late_share,
    away_tm_scored_late_share   = tma.tm_scored_late_share,
    home_tm_conceded_late_share = tmh.tm_conceded_late_share,
    away_tm_conceded_late_share = tma.tm_conceded_late_share,
    home_tm_scored_r1_rate      = tmh.tm_scored_r1_rate,
    away_tm_scored_r1_rate      = tma.tm_scored_r1_rate,
    home_tm_scored_r2_rate      = tmh.tm_scored_r2_rate,
    away_tm_scored_r2_rate      = tma.tm_scored_r2_rate
FROM fixtures_history fh,
     LATERAL (${timingBody('fh.home_team_id', 'fh.match_date')}) tmh,
     LATERAL (${timingBody('fh.away_team_id', 'fh.match_date')}) tma
WHERE fh.fixture_id = mf.fixture_id
  AND mf.fixture_id = ANY($1::int[])
`;

async function ensureSettings() {
  await query(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMP DEFAULT NOW())`).catch(() => {});
}
async function getCursor() {
  const r = await query("SELECT value FROM app_settings WHERE key=$1", [CURSOR_KEY]);
  return parseInt(r.rows[0]?.value || '0', 10) || 0;
}
async function setCursor(v) {
  await query(`INSERT INTO app_settings (key, value) VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [CURSOR_KEY, String(v)]);
}

async function main() {
  await ensureSettings();
  if (RESET) { await setCursor(0); console.log("Cursor resetat la 0."); }
  let cursor = await getCursor();

  const tot = await query("SELECT COUNT(*)::int AS n, COALESCE(MAX(fixture_id),0) AS mx FROM ml_features");
  const totalRows = tot.rows[0]?.n || 0;
  console.log(`ml_features: ${totalRows} rânduri | cursor start: ${cursor} | batch: ${BATCH}`);
  if (totalRows === 0) { await pool.end(); return; }

  let updated = 0, scanned = 0, batches = 0;
  for (;;) {
    const ids = await query(
      "SELECT fixture_id FROM ml_features WHERE fixture_id > $1 ORDER BY fixture_id ASC LIMIT $2",
      [cursor, BATCH]);
    if (ids.rows.length === 0) break;
    const arr = ids.rows.map(r => r.fixture_id);
    const res = await query(UPDATE_SQL, [arr]);
    updated += res.rowCount || 0;
    scanned += arr.length;
    cursor = arr[arr.length - 1];          // max fixture_id din batch (ASC)
    await setCursor(cursor);
    batches++;
    console.log(`  batch ${batches}: scanate ${scanned} | actualizate ${updated} | cursor ${cursor}`);
  }

  // Verificare acoperire finală (read-only).
  const cov = await query(
    "SELECT COUNT(*)::int AS total, COUNT(home_tm_scored_r2_rate)::int AS cu_timing FROM ml_features");
  const c = cov.rows[0] || { total: 0, cu_timing: 0 };
  console.log(`\nGATA. Rânduri scanate: ${scanned} | UPDATE-uri: ${updated}`);
  console.log(`Acoperire ml_features: ${c.cu_timing}/${c.total} cu timing non-NULL ` +
    `(${c.total ? (100 * c.cu_timing / c.total).toFixed(1) : 0}%). ` +
    `Restul = <5 meciuri anterioare sau fără fixtures_history (NULL corect).`);
  console.log("NON-destructiv: doar cele 12 coloane timing au fost scrise. Re-rulabil (idempotent).");
  await pool.end();
}

main().catch(async (e) => { console.error("EROARE:", e.message); try { await pool.end(); } catch (_) {} process.exit(1); });
