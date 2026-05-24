#!/usr/bin/env node
// NGP Backtest — măsoară calibrarea formulelor NGP pe date istorice
//
// Citește live_stats (snapshot-uri per minut per meci) + fixtures_history (scoruri finale)
// Pentru fiecare snapshot, calculează NGP cu mai multe formule și verifică dacă a venit
// gol până la finalul meciului. Output: curba de calibrare per formulă + Brier score.
//
// Rulare pe VPS:
//   cd /var/www/scannerv2  (sau unde e clonat repo-ul)
//   node scripts/ngp-backtest.js
//   node scripts/ngp-backtest.js --limit 500    (mai rapid)
//   node scripts/ngp-backtest.js --json > backtest.json
//
// Output: tabele pe stdout + optional JSON

import { query } from '../api/db.js';
import pool from '../api/db.js';

// ── Parse args ────────────────────────────────────────────────
const args = process.argv.slice(2);
const limit = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : 2000;
})();
const jsonOnly = args.includes('--json');

const log = (...m) => { if (!jsonOnly) console.log(...m); };

// ── Formule NGP — 5 variante de testat ────────────────────────
// Toate primesc același obiect: { mn, hxg, axg, hSOT, aSOT, hDA, aDA, hg, ag }

// V0: Formula CURENTĂ din live-score.js (form fallback cu default 0.35)
function ngpV0_current(s) {
  const mn = s.mn || 0;
  const txg = (s.hxg || 0) + (s.axg || 0);
  const remFrac = Math.max(0, Math.min(1, (90 - mn) / 90));
  let remXg = (txg / Math.max(mn, 1)) * (90 - mn);
  if (txg === 0) {
    remXg = ((0.35 + 0.35) / 2 * 2.5) * remFrac;  // form default
  }
  if (mn >= 70) remXg *= 1.2;
  if (mn >= 80) remXg *= 1.15;
  const prob = 1 - Math.exp(-Math.max(remXg, 0.05));
  return Math.round(Math.max(3, Math.min(97, prob * 100)));
}

// V1: SOT-derived (fix-ul meu de azi din /api/football)
function ngpV1_sotDerived(s) {
  const mn = s.mn || 0;
  const txg = (s.hxg || 0) + (s.axg || 0);
  const homeFormGoals = (mn > 0 && s.hSOT > 0) ? (s.hSOT / mn) * 9 : 0.35;
  const awayFormGoals = (mn > 0 && s.aSOT > 0) ? (s.aSOT / mn) * 9 : 0.35;
  const remFrac = Math.max(0, Math.min(1, (90 - mn) / 90));
  let remXg = (txg / Math.max(mn, 1)) * (90 - mn);
  if (txg === 0) {
    remXg = ((homeFormGoals + awayFormGoals) / 2 * 2.5) * remFrac;
  }
  if (mn >= 70) remXg *= 1.2;
  if (mn >= 80) remXg *= 1.15;
  const prob = 1 - Math.exp(-Math.max(remXg, 0.05));
  return Math.round(Math.max(3, Math.min(97, prob * 100)));
}

// V2: SOT-conversion (10% SOT→gol, ignoră xG)
function ngpV2_sotConv(s) {
  const mn = s.mn || 0;
  const tSOT = (s.hSOT || 0) + (s.aSOT || 0);
  const sotRate = tSOT / Math.max(mn, 1);
  const remGoals = sotRate * (90 - mn) * 0.10;
  const prob = 1 - Math.exp(-Math.max(remGoals, 0.05));
  return Math.round(Math.max(3, Math.min(97, prob * 100)));
}

// V3: Hibrid xG + SOT-conversion (preferă xG dacă există)
function ngpV3_hybrid(s) {
  const mn = s.mn || 0;
  const txg = (s.hxg || 0) + (s.axg || 0);
  const tSOT = (s.hSOT || 0) + (s.aSOT || 0);
  let remGoals;
  if (txg > 0.3) {
    remGoals = (txg / Math.max(mn, 1)) * (90 - mn);
  } else if (tSOT > 0) {
    remGoals = (tSOT / Math.max(mn, 1)) * (90 - mn) * 0.10;
  } else {
    remGoals = 0.5 * Math.max(0, (90 - mn) / 90);  // fallback conservator
  }
  const prob = 1 - Math.exp(-Math.max(remGoals, 0.05));
  return Math.round(Math.max(3, Math.min(97, prob * 100)));
}

// V4: Hibrid cu Dangerous Attacks signal (DA = pre-shot threat)
function ngpV4_hybridDA(s) {
  const mn = s.mn || 0;
  const txg = (s.hxg || 0) + (s.axg || 0);
  const tSOT = (s.hSOT || 0) + (s.aSOT || 0);
  const tDA  = (s.hDA  || 0) + (s.aDA  || 0);

  let remGoals;
  if (txg > 0.3) {
    remGoals = (txg / Math.max(mn, 1)) * (90 - mn);
  } else if (tSOT > 0) {
    remGoals = (tSOT / Math.max(mn, 1)) * (90 - mn) * 0.10;
  } else if (tDA > 30) {
    // DA fallback — atacuri periculoase / minut, ~1.5% conversie la gol
    remGoals = (tDA / Math.max(mn, 1)) * (90 - mn) * 0.015;
  } else {
    remGoals = 0.5 * Math.max(0, (90 - mn) / 90);
  }
  const prob = 1 - Math.exp(-Math.max(remGoals, 0.05));
  return Math.round(Math.max(3, Math.min(97, prob * 100)));
}

const FORMULAS = {
  V0_current:     ngpV0_current,
  V1_sotDerived:  ngpV1_sotDerived,
  V2_sotConv:     ngpV2_sotConv,
  V3_hybrid:      ngpV3_hybrid,
  V4_hybridDA:    ngpV4_hybridDA,
};

// ── Backtest core ─────────────────────────────────────────────

async function backtest() {
  log(`\n🔍 NGP Backtest — limit ${limit} fixtures\n`);

  // 1. Eșantion: meciuri FT cu live_stats disponibil
  log('📊 Selectez meciuri FT cu istoric live_stats...');
  const fxRes = await query(`
    SELECT fh.fixture_id,
           fh.home_goals AS final_home,
           fh.away_goals AS final_away,
           fh.league_id
    FROM fixtures_history fh
    WHERE fh.status_short = 'FT'
      AND fh.home_goals IS NOT NULL
      AND fh.away_goals IS NOT NULL
      AND EXISTS (SELECT 1 FROM live_stats ls WHERE ls.fixture_id = fh.fixture_id)
    ORDER BY fh.match_date DESC NULLS LAST
    LIMIT $1
  `, [limit]);

  log(`   ${fxRes.rows.length} meciuri FT cu live_stats găsite`);
  if (fxRes.rows.length === 0) {
    log('\n⚠️  Niciun meci găsit. Verifică că live_stats are date și fixtures_history are FT-uri.');
    return null;
  }

  // 2. Pentru fiecare meci, citește toate snapshot-urile și evaluează formulele
  log('🧮 Evaluez snapshot-uri per meci...');
  const samples = [];  // {formula, ng, hit, minute, fixture_id}
  let totalSnaps = 0, skippedSnaps = 0;

  for (const fx of fxRes.rows) {
    const snapsRes = await query(`
      SELECT elapsed, home_goals, away_goals,
             home_sot, away_sot, home_da, away_da,
             home_xg, away_xg
      FROM live_stats
      WHERE fixture_id = $1 AND elapsed IS NOT NULL
      ORDER BY elapsed ASC
    `, [fx.fixture_id]);

    const finalGoals = (fx.final_home || 0) + (fx.final_away || 0);

    for (const r of snapsRes.rows) {
      totalSnaps++;
      const mn = r.elapsed;
      if (mn < 5 || mn > 85) { skippedSnaps++; continue; }  // ignoră începutul și finalul

      const goalsAtMn = (r.home_goals || 0) + (r.away_goals || 0);
      const hit = finalGoals > goalsAtMn;  // a venit gol după acest minut?

      const s = {
        mn,
        hxg: parseFloat(r.home_xg) || 0,
        axg: parseFloat(r.away_xg) || 0,
        hSOT: r.home_sot || 0,
        aSOT: r.away_sot || 0,
        hDA: r.home_da || 0,
        aDA: r.away_da || 0,
        hg: r.home_goals || 0,
        ag: r.away_goals || 0,
      };

      for (const [name, fn] of Object.entries(FORMULAS)) {
        const ng = fn(s);
        samples.push({ formula: name, ng, hit, minute: mn, fixture_id: fx.fixture_id });
      }
    }
  }

  log(`   ${totalSnaps} snapshot-uri totale, ${skippedSnaps} ignorate (min<5 sau >85)`);
  log(`   ${samples.length} predicții evaluate (${Object.keys(FORMULAS).length} formule × snapshot-uri valide)\n`);

  // 3. Per formulă: curbă calibrare + Brier score
  const report = { meta: { limit, fixtures: fxRes.rows.length, totalSnaps, validSnaps: samples.length / Object.keys(FORMULAS).length }, formulas: {} };

  for (const fname of Object.keys(FORMULAS)) {
    const fSamples = samples.filter(s => s.formula === fname);

    // Bucket-uri NGP 0-10, 10-20, ..., 90-100
    const buckets = [];
    for (let i = 0; i < 10; i++) {
      buckets.push({ lower: i * 10, upper: (i + 1) * 10, count: 0, hits: 0 });
    }
    for (const s of fSamples) {
      const idx = Math.min(9, Math.floor(s.ng / 10));
      buckets[idx].count++;
      if (s.hit) buckets[idx].hits++;
    }

    // Brier score (eroare medie pătratică)
    const brier = fSamples.reduce((sum, s) =>
      sum + Math.pow(s.ng / 100 - (s.hit ? 1 : 0), 2), 0) / fSamples.length;

    // Log loss
    const eps = 1e-15;
    const logLoss = -fSamples.reduce((sum, s) => {
      const p = Math.min(1 - eps, Math.max(eps, s.ng / 100));
      return sum + (s.hit ? Math.log(p) : Math.log(1 - p));
    }, 0) / fSamples.length;

    // Calibration error: medie |predicted - actual| pe bucket-uri populate
    let ceSum = 0, ceCount = 0;
    for (const b of buckets) {
      if (b.count >= 10) {
        const predicted = (b.lower + b.upper) / 2 / 100;
        const actual = b.hits / b.count;
        ceSum += Math.abs(predicted - actual) * b.count;
        ceCount += b.count;
      }
    }
    const calibErr = ceCount > 0 ? ceSum / ceCount : null;

    report.formulas[fname] = {
      brier: +brier.toFixed(4),
      logLoss: +logLoss.toFixed(4),
      calibErr: calibErr !== null ? +calibErr.toFixed(4) : null,
      buckets: buckets.map(b => ({
        range: `${b.lower}-${b.upper}%`,
        samples: b.count,
        hits: b.hits,
        actualRate: b.count > 0 ? +(b.hits / b.count * 100).toFixed(1) : null,
      })),
    };
  }

  return report;
}

// ── Output ────────────────────────────────────────────────────

function printReport(report) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  REZULTATE BACKTEST');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log(`Meciuri analizate: ${report.meta.fixtures}`);
  console.log(`Snapshot-uri totale: ${report.meta.totalSnaps}`);
  console.log(`Predicții per formulă: ${Math.round(report.meta.validSnaps)}\n`);

  // Comparație globală
  console.log('📈 COMPARAȚIE METRICI (lower = better)');
  console.log('─────────────────────────────────────────────────────────────');
  console.log('Formula           | Brier    | Log Loss | Calib Err');
  console.log('─────────────────────────────────────────────────────────────');
  for (const [name, m] of Object.entries(report.formulas)) {
    const ce = m.calibErr !== null ? m.calibErr.toFixed(4) : '   N/A';
    console.log(`${name.padEnd(18)}|  ${m.brier.toFixed(4)} |  ${m.logLoss.toFixed(4)} |  ${ce}`);
  }
  console.log('─────────────────────────────────────────────────────────────\n');

  // Best formula
  const best = Object.entries(report.formulas).reduce((b, [n, m]) =>
    !b || m.brier < b[1].brier ? [n, m] : b, null);
  console.log(`🏆 Cea mai bună (Brier): ${best[0]}\n`);

  // Curba calibrare per formulă
  for (const [name, m] of Object.entries(report.formulas)) {
    console.log(`📊 ${name} — calibrare:`);
    console.log('   NGP range  | Predicții | Goluri | Rate real | Bias');
    console.log('   ─────────────────────────────────────────────────────');
    for (const b of m.buckets) {
      if (b.samples === 0) continue;
      const predMid = (parseInt(b.range) + parseInt(b.range.split('-')[1])) / 2;
      const actual = b.actualRate;
      const bias = actual !== null ? (actual - predMid).toFixed(1).padStart(6) : '   N/A';
      const flag = actual !== null
        ? (Math.abs(actual - predMid) > 15 ? '⚠️' : Math.abs(actual - predMid) > 8 ? '⚡' : '✓')
        : '';
      console.log(`   ${b.range.padEnd(10)} | ${String(b.samples).padStart(9)} | ${String(b.hits).padStart(6)} | ${(actual !== null ? actual.toFixed(1) + '%' : 'N/A').padStart(9)} | ${bias} ${flag}`);
    }
    console.log('');
  }

  console.log('Legend: ✓ bias<8pp  ⚡ bias 8-15pp  ⚠️ bias>15pp');
  console.log('Bias = (rate real - mijloc range). Pozitiv = subestimare, negativ = supraestimare.\n');
}

// ── Run ───────────────────────────────────────────────────────

(async () => {
  try {
    const report = await backtest();
    if (!report) { await pool.end(); process.exit(0); }

    if (jsonOnly) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }

    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error('Eroare:', e.message);
    console.error(e.stack);
    await pool.end().catch(() => {});
    process.exit(1);
  }
})();
