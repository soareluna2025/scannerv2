// Auto-recalibrare a tabelei G2_CALIBRATION pe baza datelor reale din DB.
// Ruleaza saptamanal (sau on-demand) si construieste bucket-uri actualizate
// din predictions.result_over15 + over15_prob/gg_prob/etc.
//
// SPRINT 4B — Calibrare per-profil de ligă (low/mid/high scoring):
//   Pentru fiecare modul calculez:
//     - varianta GLOBALĂ (toate ligile) — fallback universal
//     - varianta LOW   (avg_goals_per_match < 2.3)   dacă N >= 500
//     - varianta MID   (2.3 <= avg_goals_per_match < 3.0) dacă N >= 500
//     - varianta HIGH  (avg_goals_per_match >= 3.0)  dacă N >= 500
//   league_group e EXCLUSIV derivat din league_stats.avg_goals_per_match
//   (zero valori hardcodate per ligă).
//
// Output: tabela calibration_tables (module, league_group) PK
// Trigger: GET /api/cron/recalibrate-tables
// Pe VPS in crontab: 0 5 * * 0  (dum 05:00, weekly)

import { query } from '../db.js';

const MODULES = [
  // [moduleKey, columnName, marketKey for result_xxx]
  ['goals_total_0.5', 'over15_prob', 'over15'],  // proxy approximat
  ['goals_total_1.5', 'over15_prob', 'over15'],
  ['goals_total_2.5', 'over25_prob', 'over25'],
  ['gg',              'gg_prob',     'gg'],
];

const STD_BUCKETS = [
  [0, 30], [30, 40], [40, 50], [50, 60], [60, 70], [70, 80], [80, 90], [90, 101]
];

// Pragul minim pentru a accepta o tabelă per-grup. Sub asta → folosim global.
const MIN_GROUP_SAMPLES  = 500;
const MIN_GLOBAL_SAMPLES = 50;

function classifyLeague(avgGoals) {
  if (avgGoals == null || !Number.isFinite(avgGoals)) return null;
  if (avgGoals < 2.3) return 'low';
  if (avgGoals < 3.0) return 'mid';
  return 'high';
}

async function ensureTable() {
  // Schema nouă cu PK compus (module, league_group)
  await query(`
    CREATE TABLE IF NOT EXISTS calibration_tables (
      module       TEXT NOT NULL,
      league_group TEXT NOT NULL DEFAULT 'global',
      buckets      JSONB NOT NULL,
      sample_size  INT,
      brier_score  NUMERIC(5,3),
      generated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (module, league_group)
    )
  `);

  // Migrare pentru tabele vechi (PK doar pe module):
  await query(
    `ALTER TABLE calibration_tables ADD COLUMN IF NOT EXISTS league_group TEXT NOT NULL DEFAULT 'global'`
  ).catch(() => {});
  await query(`
    DO $do$
    DECLARE
      pk_cols INT;
    BEGIN
      SELECT COUNT(*) INTO pk_cols
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'calibration_tables'::regclass
         AND i.indisprimary;
      IF pk_cols = 1 THEN
        EXECUTE 'ALTER TABLE calibration_tables DROP CONSTRAINT calibration_tables_pkey';
        EXECUTE 'ALTER TABLE calibration_tables ADD PRIMARY KEY (module, league_group)';
      END IF;
    END
    $do$
  `).catch(() => {});
}

function brierFromRows(rows) {
  if (!rows.length) return null;
  let sum = 0;
  for (const r of rows) {
    const p = Number(r.raw) / 100;
    const a = r.actual ? 1 : 0;
    sum += (p - a) ** 2;
  }
  return +(sum / rows.length).toFixed(3);
}

function buildBuckets(rows) {
  const buckets = STD_BUCKETS.map(([min, max]) => {
    const inBucket = rows.filter(r => r.raw >= min && r.raw < max);
    const n = inBucket.length;
    const hits = inBucket.filter(r => r.actual === true).length;
    const pct = n > 0 ? Math.round(hits / n * 100) : null;
    return { min, max, n, pct };
  });
  // Bucket-uri cu n<5 sau pct=null sunt ignorate
  return buckets.filter(b => b.n >= 5 && b.pct !== null);
}

async function upsertCalibration(moduleKey, leagueGroup, buckets, n, brier) {
  await query(`
    INSERT INTO calibration_tables (module, league_group, buckets, sample_size, brier_score, generated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (module, league_group) DO UPDATE SET
      buckets      = EXCLUDED.buckets,
      sample_size  = EXCLUDED.sample_size,
      brier_score  = EXCLUDED.brier_score,
      generated_at = EXCLUDED.generated_at
  `, [moduleKey, leagueGroup, JSON.stringify(buckets), n, brier]);
}

async function recalibrateModule(moduleKey, probColumn, resultMarketKey) {
  const resultColumn = `result_${resultMarketKey}`;

  // Verifica daca coloana result_* exista
  try {
    await query(`SELECT ${resultColumn} FROM predictions LIMIT 1`);
  } catch (e) {
    console.log(`[recalibrate] skip ${moduleKey}: column ${resultColumn} missing`);
    return [];
  }

  // Single query: JOIN league_stats ca să luăm avg_goals_per_match per predicție
  const { rows } = await query(`
    SELECT p.${probColumn}    AS raw,
           p.${resultColumn}  AS actual,
           ls.avg_goals_per_match AS lg_avg
      FROM predictions p
      LEFT JOIN league_stats ls ON ls.league_id = p.league_id
     WHERE p.${resultColumn} IS NOT NULL
       AND p.${probColumn}   IS NOT NULL
       AND p.created_at > NOW() - INTERVAL '180 days'
  `);

  if (rows.length < MIN_GLOBAL_SAMPLES) {
    console.log(`[recalibrate] ${moduleKey}: insufficient global samples (${rows.length}<${MIN_GLOBAL_SAMPLES}), skip`);
    return [];
  }

  // Partiționează pe league_group (low/mid/high) + global = toate
  const partitions = { global: rows, low: [], mid: [], high: [] };
  for (const r of rows) {
    const g = classifyLeague(parseFloat(r.lg_avg));
    if (g) partitions[g].push(r);
  }

  const results = [];
  for (const groupName of ['global', 'low', 'mid', 'high']) {
    const groupRows = partitions[groupName];
    const minNeeded = groupName === 'global' ? MIN_GLOBAL_SAMPLES : MIN_GROUP_SAMPLES;
    if (groupRows.length < minNeeded) {
      console.log(`[recalibrate] ${moduleKey}_${groupName}: n=${groupRows.length}<${minNeeded}, skip`);
      continue;
    }

    const validBuckets = buildBuckets(groupRows);
    if (!validBuckets.length) {
      console.log(`[recalibrate] ${moduleKey}_${groupName}: no valid buckets (need n>=5/bucket)`);
      continue;
    }

    const brier = brierFromRows(groupRows);
    await upsertCalibration(moduleKey, groupName, validBuckets, groupRows.length, brier);

    console.log(`[recalibrate] ${moduleKey}_${groupName}: n=${groupRows.length}, brier=${brier}, valid_buckets=${validBuckets.length}`);
    results.push({
      module: moduleKey,
      league_group: groupName,
      n: groupRows.length,
      brier,
      buckets: validBuckets,
    });
  }
  return results;
}

export default async function handler(req, res) {
  try {
    await ensureTable();
    const results = [];
    for (const [moduleKey, probCol, marketKey] of MODULES) {
      const rs = await recalibrateModule(moduleKey, probCol, marketKey);
      results.push(...rs);
    }
    await Promise.resolve(/* cron_logs → dispecer */).catch(() => {});

    return res.status(200).json({
      ok: true,
      generated_at: new Date().toISOString(),
      modules: results,
    });
  } catch (e) {
    console.error('[recalibrate-tables]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
