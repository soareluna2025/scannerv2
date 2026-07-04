// scripts/backtest-adaptive-threshold.js — BACKTEST static (70) vs adaptiv (thr_nou)
// pe prediction_log curat (fără TAINTED, fără learning_exclusions), pentru fiecare
// (modul, ligă) cu prag învățat <> 70. Output tabel + agregat + verdict ON/OFF per modul.
// READ-ONLY (doar SELECT). Rulare: cd /root/scannerv2 && node scripts/backtest-adaptive-threshold.js
import 'dotenv/config';
import { query } from '../api/db.js';
import pool from '../api/db.js';

const MODULES = ['NGP', 'OVER15', 'CONFIDENCE'];

async function main() {
  if (!process.env.POSTGRES_URL) { console.error('❌ POSTGRES_URL lipsește'); process.exit(1); }
  const { rows } = await query(`
    SELECT mw.module, mw.context_key,
           mw.weight_value AS thr_nou, mw.sample_size, mw.win_rate,
           COUNT(*) FILTER (WHERE pl.predicted_value >= 70) AS vol_static,
           ROUND(100.0*AVG((pl.outcome='WIN')::int) FILTER (WHERE pl.predicted_value >= 70),1) AS hit_static,
           COUNT(*) FILTER (WHERE pl.predicted_value >= mw.weight_value) AS vol_adaptiv,
           ROUND(100.0*AVG((pl.outcome='WIN')::int) FILTER (WHERE pl.predicted_value >= mw.weight_value),1) AS hit_adaptiv
    FROM model_weights mw
    JOIN prediction_log pl
      ON pl.module = mw.module
     AND pl.league_id = NULLIF(replace(mw.context_key,'league_',''),'')::int
    WHERE mw.weight_name='threshold'
      AND mw.module = ANY($1)
      AND mw.weight_value <> 70
      AND mw.context_key LIKE 'league_%'
      AND pl.outcome IN ('WIN','LOSS')
      AND pl.league_id NOT IN (SELECT league_id FROM learning_exclusions)
    GROUP BY mw.module, mw.context_key, mw.weight_value, mw.sample_size, mw.win_rate
    ORDER BY mw.module, mw.context_key
  `, [MODULES]);

  console.log('='.repeat(78));
  console.log('BACKTEST ADAPTIVE THRESHOLD — static(70) vs adaptiv(thr_nou)  [read-only]');
  console.log('='.repeat(78));
  if (!rows.length) { console.log('Niciun prag adaptiv <> 70 în model_weights (rulează întâi cronul P4c).'); await pool.end(); return; }

  console.log('\nPrimele 20 ligi:');
  console.log('%-12s %-10s %-6s %-9s %-9s %-9s %-9s', 'modul','liga','thr','hit_stat','vol_stat','hit_adpt','vol_adpt');
  const agg = {};
  for (const r of rows) {
    const mod = r.module, hs = r.hit_static, ha = r.hit_adaptiv;
    if (!agg[mod]) agg[mod] = { n: 0, better: 0, worse: 0, equal: 0, vs: 0, va: 0 };
    agg[mod].n++;
    const hsN = hs == null ? null : Number(hs), haN = ha == null ? null : Number(ha);
    if (hsN != null && haN != null) {
      if (haN > hsN + 0.05) agg[mod].better++;
      else if (haN < hsN - 0.05) agg[mod].worse++;
      else agg[mod].equal++;
    }
    agg[mod].vs += Number(r.vol_static) || 0;
    agg[mod].va += Number(r.vol_adaptiv) || 0;
  }
  rows.slice(0, 20).forEach(r => {
    console.log('%-12s %-10s %-6s %-9s %-9s %-9s %-9s',
      r.module, r.context_key.replace('league_',''), String(r.thr_nou),
      r.hit_static ?? 'n/a', String(r.vol_static), r.hit_adaptiv ?? 'n/a', String(r.vol_adaptiv));
  });

  console.log('\n' + '-'.repeat(78));
  console.log('AGREGAT per modul (ligi cu prag<>70):');
  console.log('%-12s %-7s %-9s %-9s %-9s %-10s %-10s', 'modul','ligi','adaptiv+','adaptiv-','egal','vol_stat','vol_adpt');
  for (const mod of MODULES) {
    const a = agg[mod]; if (!a) { console.log('%-12s (fără ligi cu prag<>70)', mod); continue; }
    console.log('%-12s %-7d %-9d %-9d %-9d %-10d %-10d', mod, a.n, a.better, a.worse, a.equal, a.vs, a.va);
  }

  console.log('\nVERDICT recomandat (heuristic — decizia finală pe shadow 24-48h):');
  for (const mod of MODULES) {
    const a = agg[mod];
    if (!a || a.n === 0) { console.log(`  ${mod}: OFF (fără date)`); continue; }
    const netBetter = a.better - a.worse;
    const verdict = (netBetter > 0 && a.better >= a.n * 0.5) ? 'ON (candidat)' : 'OFF (menține 70)';
    console.log(`  ${mod}: ${verdict}  [${a.better} mai bune / ${a.worse} mai proaste / ${a.equal} egale din ${a.n}]`);
  }
  console.log('='.repeat(78));
  await pool.end();
}
main().catch(async (e) => { console.error('❌', e.message); try { await pool.end(); } catch (_) {} process.exit(1); });
