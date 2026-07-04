// POST /api/cron/learning-analysis
// Runs daily at 03:30 — analyzes prediction_log and updates model_weights
//
// P3: GG este EXCLUS din threshold-ul adaptiv (vezi api/adaptive-threshold.js —
// ELIGIBLE_MODULES = {NGP, OVER15, CONFIDENCE}). Motiv: calibrare INVERSATĂ sus
// (60-65→60% hit, 70-75→46%), pentru că GG se loghează pre-meci/live la 0-0 și
// prob e umflată de timp. GG așteaptă recalibrare isotonic separată. Pașii de
// learning pot atinge GG, dar GG NU intră în poarta de selecție adaptivă (P4b).
import { query } from '../db.js';

const MIN_SAMPLES     = 20;
const MAX_ADJ_LOW     = 0.05;   // ±5% when confidence LOW  (<30 samples)
const MAX_ADJ_MEDIUM  = 0.10;   // ±10% MEDIUM (30-100)
const MAX_ADJ_HIGH    = 0.15;   // ±15% HIGH (>100)
const THRESHOLD_MIN   = 50;
const THRESHOLD_MAX   = 95;

function confidenceLevel(n) {
  return n < 30 ? 'LOW' : n <= 100 ? 'MEDIUM' : 'HIGH';
}
function maxAdj(n) {
  return n < 30 ? MAX_ADJ_LOW : n <= 100 ? MAX_ADJ_MEDIUM : MAX_ADJ_HIGH;
}

// P4c: clampedThresholdUpdate() ELIMINAT — formula veche era ruptă (comparatoare
// universale 0.45/0.75 vs base-rate diferit per modul → saturare garantată la clamp
// [50,95]). Înlocuită cu calcul DIRECT de prag din hit-rate real (vezi PASUL 1 nou).

// P4c: candidați de prag + ținte de hit-rate per modul (GG exclus — P3).
const THR_CANDIDATES = [60, 65, 70, 75, 80, 85, 90];
const THR_TARGETS    = { NGP: 0.80, OVER15: 0.80, CONFIDENCE: 0.75 };
const THR_MODULES    = ['NGP', 'OVER15', 'CONFIDENCE'];
const THR_MIN_LEAGUE = 100;  // min predicții rezolvate/ligă ca să calculăm prag
const THR_MIN_BAND   = 20;   // min sample la un prag candidat ca să-l acceptăm

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const started   = Date.now();
  let analyzed    = 0;
  let adjustments = 0;
  const log       = [];

  try {
    // P2: asigură tabela de excludere (idempotent) — ligi scoase din learning.
    await query(`CREATE TABLE IF NOT EXISTS learning_exclusions (
      league_id INT PRIMARY KEY, reason TEXT, added_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});

    // ── PASUL 1 (P4c): threshold ADAPTIV per (modul, ligă) din hit-rate real ─────
    // threshold = cel mai MIC prag candidat la care hit-rate(predicted_value>=prag)
    // atinge ținta modulului. Dacă niciunul → 95 (ligă practic închisă pe modul).
    // Exclude TAINTED (P1) și learning_exclusions (P2). Fereastră 365 zile.
    const _bandCols = THR_CANDIDATES.map(p =>
      `COUNT(*) FILTER (WHERE predicted_value >= ${p}) AS n_${p},
       COUNT(*) FILTER (WHERE predicted_value >= ${p} AND outcome='WIN') AS w_${p}`
    ).join(',\n');

    for (const mod of THR_MODULES) {
      const target = THR_TARGETS[mod];
      const { rows: byLeague } = await query(`
        SELECT league_id, COUNT(*) AS n_total, ${_bandCols}
        FROM prediction_log
        WHERE module=$1
          AND outcome IN ('WIN','LOSS')
          AND league_id IS NOT NULL
          AND created_at > NOW() - INTERVAL '365 days'
          AND league_id NOT IN (SELECT league_id FROM learning_exclusions)
        GROUP BY league_id
        HAVING COUNT(*) >= ${THR_MIN_LEAGUE}
      `, [mod]);

      for (const row of byLeague) {
        analyzed += Number(row.n_total);
        let chosen = null, chosenN = 0, chosenHit = 0;
        for (const p of THR_CANDIDATES) {
          const np = Number(row[`n_${p}`]) || 0;
          const wp = Number(row[`w_${p}`]) || 0;
          if (np >= THR_MIN_BAND && (wp / np) >= target) {
            chosen = p; chosenN = np; chosenHit = wp / np; break;
          }
        }
        if (chosen == null) {
          chosen = 95;
          const n90 = Number(row.n_90) || 0, w90 = Number(row.w_90) || 0;
          chosenN = n90; chosenHit = n90 > 0 ? w90 / n90 : 0;
        }
        const cl = confidenceLevel(chosenN);
        await query(
          `INSERT INTO model_weights (module, context_key, weight_name, weight_value, default_value, sample_size, win_rate, confidence_level, last_updated)
           VALUES ($1, $2, 'threshold', $3, 70, $4, $5, $6, NOW())
           ON CONFLICT (module, context_key, weight_name) DO UPDATE SET
             weight_value=EXCLUDED.weight_value, sample_size=EXCLUDED.sample_size,
             win_rate=EXCLUDED.win_rate, confidence_level=EXCLUDED.confidence_level, last_updated=NOW()`,
          [mod, `league_${row.league_id}`, chosen, chosenN, +(chosenHit * 100).toFixed(1), cl]
        );
        adjustments++;
        log.push({ type: 'threshold', module: mod, league_id: row.league_id, thr: chosen, hit: +(chosenHit*100).toFixed(1), n: chosenN, cl });
      }
    }

    // ── PASUL 2: Per interval de minut ──────────────────────────
    const minuteBands = [
      ['0_15', 0, 15], ['15_30', 15, 30], ['30_45', 30, 45],
      ['45_60', 45, 60], ['60_75', 60, 75], ['75_90', 75, 90],
    ];
    for (const [band, lo, hi] of minuteBands) {
      const { rows: bm } = await query(`
        SELECT module,
          COUNT(*) AS total,
          SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins
        FROM prediction_log
        WHERE outcome IN ('WIN','LOSS')
          AND minute >= $1 AND minute < $2
          AND created_at > NOW() - INTERVAL '90 days'
          AND league_id NOT IN (SELECT league_id FROM learning_exclusions)
        GROUP BY module
        HAVING COUNT(*) >= ${MIN_SAMPLES}
      `, [lo, hi]);

      for (const row of bm) {
        const n       = Number(row.total);
        const winRate = Number(row.wins) / n;
        const factor  = winRate > 0.70 ? 1.10 : winRate < 0.40 ? 0.90 : 1.0;
        if (factor === 1.0) continue;
        const cl = confidenceLevel(n);
        await query(
          `INSERT INTO model_weights (module, context_key, weight_name, weight_value, default_value, sample_size, win_rate, confidence_level, last_updated)
           VALUES ($1, $2, 'minute_factor', $3, 1.0, $4, $5, $6, NOW())
           ON CONFLICT (module, context_key, weight_name) DO UPDATE SET
             weight_value=EXCLUDED.weight_value, sample_size=EXCLUDED.sample_size,
             win_rate=EXCLUDED.win_rate, confidence_level=EXCLUDED.confidence_level,
             last_updated=NOW()`,
          [row.module, `minute_${band}`, factor, n, +(winRate*100).toFixed(1), cl]
        );
        adjustments++;
        log.push({ type: 'minute', band, module: row.module, factor, win_rate: +(winRate*100).toFixed(1), n });
      }
    }

    // ── PASUL 3: Per scor la momentul predicției ─────────────────
    const { rows: byScore } = await query(`
      SELECT score_at_prediction, module,
        COUNT(*) AS total,
        SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins
      FROM prediction_log
      WHERE outcome IN ('WIN','LOSS')
        AND score_at_prediction IS NOT NULL
        AND created_at > NOW() - INTERVAL '90 days'
        AND league_id NOT IN (SELECT league_id FROM learning_exclusions)
      GROUP BY score_at_prediction, module
      HAVING COUNT(*) >= ${MIN_SAMPLES}
    `);

    for (const row of byScore) {
      const n       = Number(row.total);
      const winRate = Number(row.wins) / n;
      const factor  = winRate > 0.70 ? 1.08 : winRate < 0.40 ? 0.92 : 1.0;
      if (factor === 1.0) continue;
      const ctxKey = `score_${(row.score_at_prediction||'').replace('-','_')}`;
      await query(
        `INSERT INTO model_weights (module, context_key, weight_name, weight_value, default_value, sample_size, win_rate, confidence_level, last_updated)
         VALUES ($1, $2, 'score_factor', $3, 1.0, $4, $5, $6, NOW())
         ON CONFLICT (module, context_key, weight_name) DO UPDATE SET
           weight_value=EXCLUDED.weight_value, sample_size=EXCLUDED.sample_size,
           win_rate=EXCLUDED.win_rate, confidence_level=EXCLUDED.confidence_level,
           last_updated=NOW()`,
        [row.module, ctxKey, factor, n, +(winRate*100).toFixed(1), confidenceLevel(n)]
      );
      adjustments++;
    }

    // ── PASUL 4: DEZACTIVAT (P4c) — greutățile layer CONFIDENCE sunt IMUTABILE
    //    (constituție: .30/.25/.15/.25/.05 în enrich.js, NEcitite din model_weights).
    //    Blocul citește corelațiile (inofensiv) dar NU mai scrie (guard `false`).
    const { rows: layerStats } = await query(`
      SELECT
        AVG(CASE WHEN outcome='WIN' THEN 1.0 ELSE 0.0 END) AS overall_wr,
        CORR(layer1_score, CASE WHEN outcome='WIN' THEN 1.0 ELSE 0.0 END) AS corr1,
        CORR(layer2_score, CASE WHEN outcome='WIN' THEN 1.0 ELSE 0.0 END) AS corr2,
        CORR(layer3_score, CASE WHEN outcome='WIN' THEN 1.0 ELSE 0.0 END) AS corr3,
        CORR(layer4_score, CASE WHEN outcome='WIN' THEN 1.0 ELSE 0.0 END) AS corr4,
        CORR(layer5_score, CASE WHEN outcome='WIN' THEN 1.0 ELSE 0.0 END) AS corr5,
        CORR(layer6_score, CASE WHEN outcome='WIN' THEN 1.0 ELSE 0.0 END) AS corr6,
        CORR(layer7_score, CASE WHEN outcome='WIN' THEN 1.0 ELSE 0.0 END) AS corr7,
        COUNT(*) AS total
      FROM prediction_log
      WHERE module = 'CONFIDENCE'
        AND outcome IN ('WIN','LOSS')
        AND created_at > NOW() - INTERVAL '90 days'
        AND layer1_score IS NOT NULL
        AND league_id NOT IN (SELECT league_id FROM learning_exclusions)
    `);

    if (false && layerStats[0] && Number(layerStats[0].total) >= MIN_SAMPLES) {  // P4c: scriere OPRITĂ
      const row = layerStats[0];
      const corrs = [1,2,3,4,5,6,7].map(i => Math.max(0, Number(row[`corr${i}`]) || 0));
      const total = corrs.reduce((s, v) => s + v, 0);
      if (total > 0) {
        // Get current weights
        const { rows: curW } = await query(
          `SELECT weight_name, weight_value FROM model_weights
           WHERE module='CONFIDENCE' AND context_key='global' AND weight_name LIKE 'layer%_weight'`
        );
        const curMap = Object.fromEntries(curW.map(r => [r.weight_name, Number(r.weight_value)]));
        const adj = maxAdj(Number(row.total));

        for (let i = 1; i <= 7; i++) {
          const name    = `layer${i}_weight`;
          const curVal  = curMap[name] || 0.14;
          const target  = corrs[i-1] / total;
          // Blend: 20% toward correlation-based target, capped by adj
          const delta   = Math.min(adj, Math.abs(target - curVal)) * Math.sign(target - curVal);
          const newVal  = Math.max(0.02, Math.min(0.50, curVal + delta * 0.2));
          await query(
            `UPDATE model_weights SET weight_value=$1, last_updated=NOW()
             WHERE module='CONFIDENCE' AND context_key='global' AND weight_name=$2`,
            [+newVal.toFixed(4), name]
          );
        }
        // Normalize so sum = 1.0
        const { rows: fresh } = await query(
          `SELECT weight_name, weight_value FROM model_weights
           WHERE module='CONFIDENCE' AND context_key='global' AND weight_name LIKE 'layer%_weight'`
        );
        const sum = fresh.reduce((s, r) => s + Number(r.weight_value), 0);
        if (sum > 0) {
          for (const r of fresh) {
            await query(
              `UPDATE model_weights SET weight_value=$1 WHERE module='CONFIDENCE' AND context_key='global' AND weight_name=$2`,
              [+(Number(r.weight_value) / sum).toFixed(4), r.weight_name]
            );
          }
        }
        adjustments += 7;
        log.push({ type: 'confidence_layers', n: Number(row.total), normalized: true });
      }
    }

    // ── PASUL 6: Lambda multiplier per ligă ─────────────────────
    // Compară predicțiile over15_prob vs rata reală — calculează factor de corecție
    // Filtru over15_prob >= 55: excludem meciurile unde modelul a prezis activ Under 1.5
    // (includererea lor dilua media si producea un multiplicator sistematic supraevaluat)
    const { rows: byLeagueLambda } = await query(`
      SELECT league_id,
        COUNT(*) AS n,
        AVG(over15_prob) AS avg_predicted,
        AVG(CASE WHEN result_over15 THEN 100.0 ELSE 0.0 END) AS actual_rate
      FROM predictions
      WHERE result_over15 IS NOT NULL
        AND league_id IS NOT NULL
        AND over15_prob >= 55
        AND updated_at > NOW() - INTERVAL '90 days'
      GROUP BY league_id
      HAVING COUNT(*) >= ${MIN_SAMPLES}
    `);

    for (const row of byLeagueLambda) {
      const n          = Number(row.n);
      const avgPred    = Number(row.avg_predicted);
      const actualRate = Number(row.actual_rate);
      if (avgPred < 1) continue;

      const rawMult = actualRate / avgPred;
      const mult    = Math.max(0.80, Math.min(1.20, rawMult));

      // Actualizează doar dacă bias-ul depășește 5%
      if (Math.abs(mult - 1.0) < 0.05) continue;

      const cl = confidenceLevel(n);
      await query(
        `INSERT INTO model_weights (module, context_key, weight_name, weight_value, default_value, sample_size, win_rate, confidence_level, last_updated)
         VALUES ($1, $2, 'lambda_multiplier', $3, 1.0, $4, $5, $6, NOW())
         ON CONFLICT (module, context_key, weight_name) DO UPDATE SET
           weight_value=EXCLUDED.weight_value, sample_size=EXCLUDED.sample_size,
           win_rate=EXCLUDED.win_rate, confidence_level=EXCLUDED.confidence_level,
           last_updated=NOW()`,
        ['OVER15', `league_${row.league_id}`, +mult.toFixed(4), n, +actualRate.toFixed(1), cl]
      );
      adjustments++;
      log.push({
        type: 'lambda_mult', league_id: row.league_id,
        mult: +mult.toFixed(4), avg_predicted: +avgPred.toFixed(1),
        actual_rate: +actualRate.toFixed(1), n,
      });
    }

    // ── PASUL 5: Log în cron_logs ────────────────────────────────
    await Promise.resolve(/* cron_logs → dispecer */).catch(() => {});

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    return res.json({
      ok: true,
      analyzed,
      adjustments,
      elapsed_s: elapsed,
      log: log.slice(0, 50),
    });
  } catch (e) {
    await Promise.resolve(/* cron_logs → dispecer */).catch(() => {});
    return res.status(500).json({ ok: false, error: e.message });
  }
}
