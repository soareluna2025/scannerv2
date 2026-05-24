// Auto-recalibrare a tabelei G2_CALIBRATION pe baza datelor reale din DB.
// Ruleaza saptamanal (sau on-demand) si construieste bucket-uri actualizate
// din predictions.result_over15 + over15_prob/gg_prob/etc.
//
// Output: tabela calibration_tables in DB, cu mapping per (module, raw_bucket -> real_pct)
//
// Trigger: GET /api/cron/recalibrate-tables
// Pe VPS in crontab: 0 5 * * 0  (dum 05:00, weekly)

import { query } from '../db.js';

const MODULES = [
  // [moduleKey, columnName, bucketsBreakpoints (min,max ranges in 10% steps)]
  ['goals_total_0.5', 'over15_prob', 'over15'],  // proxy approximat
  ['goals_total_1.5', 'over15_prob', 'over15'],
  ['goals_total_2.5', 'over25_prob', 'over25'],
  ['gg',              'gg_prob',     'gg'],
];

const STD_BUCKETS = [
  [0, 30], [30, 40], [40, 50], [50, 60], [60, 70], [70, 80], [80, 90], [90, 101]
];

async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS calibration_tables (
      module       TEXT PRIMARY KEY,
      buckets      JSONB NOT NULL,
      sample_size  INT,
      brier_score  NUMERIC(5,3),
      generated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

// Calculeaza Brier score: medie ((pred - actual)^2) pe toate predictiile
async function computeBrier(probColumn, resultColumn) {
  const { rows } = await query(`
    SELECT ${probColumn} AS prob, ${resultColumn} AS actual
    FROM predictions
    WHERE ${resultColumn} IS NOT NULL
      AND ${probColumn} IS NOT NULL
      AND created_at > NOW() - INTERVAL '180 days'
  `);
  if (!rows.length) return null;
  let sum = 0;
  for (const r of rows) {
    const p = Number(r.prob) / 100;
    const a = r.actual ? 1 : 0;
    sum += (p - a) ** 2;
  }
  return +(sum / rows.length).toFixed(3);
}

async function recalibrateModule(moduleKey, probColumn, resultMarketKey) {
  // Pentru market = 'over15' folosesc result_over15; pentru 'over25' result_over25; etc.
  const resultColumn = `result_${resultMarketKey}`;

  // Verifica daca coloana exista (pe predictions)
  try {
    await query(`SELECT ${resultColumn} FROM predictions LIMIT 1`);
  } catch (e) {
    console.log(`[recalibrate] skip ${moduleKey}: column ${resultColumn} missing`);
    return null;
  }

  const { rows } = await query(`
    SELECT
      ${probColumn} AS raw,
      ${resultColumn} AS actual
    FROM predictions
    WHERE ${resultColumn} IS NOT NULL
      AND ${probColumn} IS NOT NULL
      AND created_at > NOW() - INTERVAL '180 days'
  `);

  if (rows.length < 50) {
    console.log(`[recalibrate] ${moduleKey}: insufficient samples (${rows.length}), skip`);
    return null;
  }

  // Build buckets cu real_pct
  const buckets = STD_BUCKETS.map(([min, max]) => {
    const inBucket = rows.filter(r => r.raw >= min && r.raw < max);
    const n = inBucket.length;
    const hits = inBucket.filter(r => r.actual === true).length;
    const pct = n > 0 ? Math.round(hits / n * 100) : null;
    return { min, max, n, pct };
  });

  // Filtru: bucket-urile cu n < 5 sunt ignorate (real_pct = null)
  // Frontend va folosi fallback la valoarea adiacenta
  const validBuckets = buckets.filter(b => b.n >= 5 && b.pct !== null);
  if (!validBuckets.length) {
    console.log(`[recalibrate] ${moduleKey}: no valid buckets (need n>=5)`);
    return null;
  }

  const brier = await computeBrier(probColumn, resultColumn);

  // Stocheaza
  await query(`
    INSERT INTO calibration_tables (module, buckets, sample_size, brier_score, generated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (module) DO UPDATE SET
      buckets = EXCLUDED.buckets,
      sample_size = EXCLUDED.sample_size,
      brier_score = EXCLUDED.brier_score,
      generated_at = EXCLUDED.generated_at
  `, [moduleKey, JSON.stringify(validBuckets), rows.length, brier]);

  console.log(`[recalibrate] ${moduleKey}: n=${rows.length}, brier=${brier}, valid_buckets=${validBuckets.length}`);
  return { module: moduleKey, n: rows.length, brier, buckets: validBuckets };
}

export default async function handler(req, res) {
  try {
    await ensureTable();
    const results = [];
    for (const [moduleKey, probCol, marketKey] of MODULES) {
      const r = await recalibrateModule(moduleKey, probCol, marketKey);
      if (r) results.push(r);
    }
    // Log in cron_logs
    await query(`
      INSERT INTO cron_logs (job_name, ran_at, status, fixtures_processed)
      VALUES ('recalibrate-tables', NOW(), $1, $2)
    `, [results.length ? 'success' : 'no_data', results.length]).catch(() => {});

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
