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

  const pad = (v, n) => String(v).padEnd(n);
  console.log('\nPrimele 20 ligi:');
  console.log(pad('modul',12)+pad('liga',10)+pad('thr',6)+pad('hit_stat',9)+pad('vol_stat',9)+pad('hit_adpt',9)+'vol_adpt');
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
    console.log(pad(r.module,12)+pad(r.context_key.replace('league_',''),10)+pad(r.thr_nou,6)+
      pad(r.hit_static ?? 'n/a',9)+pad(r.vol_static,9)+pad(r.hit_adaptiv ?? 'n/a',9)+String(r.vol_adaptiv));
  });

  console.log('\n' + '-'.repeat(78));
  console.log('AGREGAT per modul (ligi cu prag<>70):');
  console.log(pad('modul',12)+pad('ligi',7)+pad('adaptiv+',9)+pad('adaptiv-',9)+pad('egal',9)+pad('vol_stat',10)+'vol_adpt');
  for (const mod of MODULES) {
    const a = agg[mod]; if (!a) { console.log(pad(mod,12)+'(fără ligi cu prag<>70)'); continue; }
    console.log(pad(mod,12)+pad(a.n,7)+pad(a.better,9)+pad(a.worse,9)+pad(a.equal,9)+pad(a.vs,10)+String(a.va));
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
