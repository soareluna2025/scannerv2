const { Client } = require('pg');
require('dotenv').config({ path: '/root/scannerv2/.env' });
const args = process.argv.slice(2);
const getArg = (n, d) => { const a = args.find(x => x.startsWith('--'+n+'=')); return a ? a.split('=')[1] : d; };
const LIMIT = parseInt(getArg('limit', '500'), 10);
const YEAR = parseInt(getArg('year', '2022'), 10);
const COMMIT = args.includes('--commit');
const DRY = !COMMIT;
const N = (v) => v == null ? null : Number(v);
const okNum = (v) => v != null && !isNaN(v);
function calcStr(rows) {
  if (!Array.isArray(rows) || rows.length < 10) return null;
  const rated = rows.filter(r => r.rating);
  const avgRating = rated.length ? rated.reduce((s, r) => s + Number(r.rating), 0) / rated.length : 5;
  const goalsPerGame = rows.reduce((s, r) => s + (Number(r.goals) || 0), 0) / rows.length;
  const withPass = rows.filter(r => r.pass_accuracy != null);
  const avgPassAcc = withPass.length ? withPass.reduce((s, r) => s + Number(r.pass_accuracy), 0) / withPass.length : 50;
  const avgSot = rows.reduce((s, r) => s + (Number(r.shots_on_target) || 0), 0) / rows.length;
  const topScorer = Math.max(...rows.map(r => Number(r.goals) || 0), 0);
  return Math.round((avgRating/10*100)*0.35 + Math.min(100,goalsPerGame*35)*0.25 + avgPassAcc*0.20 + Math.min(100,avgSot*12)*0.10 + Math.min(100,topScorer*20)*0.10);
}
function calcScore7(h, a) {
  if (h == null && a == null) return null;
  const hs = h == null ? 50 : h, as = a == null ? 50 : a;
  const hd = hs*(100-as)/100, ad = as*(100-hs)/100;
  return Math.max(0, Math.min(100, Math.round((hd+ad)/2*1.5)));
}
function calcConvergence(all) {
  const act = all.filter(v => v != null && !isNaN(v));
  if (act.length < 2) return null;
  const m = act.reduce((s,v)=>s+v,0)/act.length;
  const va = act.reduce((s,v)=>s+(v-m)*(v-m),0)/act.length;
  return Math.round(Math.max(0, Math.min(100, 100-Math.sqrt(va))));
}
function calcConfidence(s1, s2, s3, s6, s7) {
  const L = [{s:s1,w:0.30},{s:s2,w:0.25},{s:s3,w:0.15},{s:s7,w:0.25},{s:s6,w:0.05}];
  const f = L.filter(l => l.s !== null && !isNaN(l.s) && l.w > 0);
  const tw = f.reduce((s,l)=>s+l.w,0);
  if (tw === 0) return null;
  return Math.max(5, Math.min(100, Math.round(f.reduce((s,l)=>s+l.s*(l.w/tw),0))));
}
async function main() {
  const client = new Client({ connectionString: process.env.POSTGRES_URL });
  await client.connect();
  console.log('='.repeat(60));
  console.log('RECOMPUTE score7 PIT | MOD: ' + (DRY ? 'DRY-RUN' : 'COMMIT'));
  console.log('An: ' + YEAR + ' | Limit: ' + LIMIT);
  console.log('='.repeat(60));
  const { rows: preds } = await client.query("SELECT p.fixture_id, p.match_date, p.confidence AS conf_vechi, p.score1, p.score2, p.score3, p.result_over15, fh.home_team_id, fh.away_team_id FROM predictions p JOIN fixtures_history fh ON fh.fixture_id = p.fixture_id WHERE date_part('year', p.match_date) = $1 AND p.result_over15 IS NOT NULL AND p.score7 IS NULL AND fh.home_team_id IS NOT NULL AND fh.away_team_id IS NOT NULL ORDER BY p.match_date LIMIT $2", [YEAR, LIMIT]);
  console.log('\nPredictii de procesat: ' + preds.length + '\n');
  if (preds.length === 0) { console.log('Nimic de procesat.'); await client.end(); return; }
  let processed = 0, s7_calc = 0, s7_null = 0, updated = 0;
  const rezV = [], rezN = [];
  const q = 'SELECT ps.rating, ps.goals, ps.pass_accuracy, ps.shots_on_target FROM player_stats ps JOIN fixtures_history fh ON fh.fixture_id = ps.fixture_id WHERE ps.team_id = $1 AND fh.match_date < $2 ORDER BY fh.match_date DESC LIMIT 110';
  for (const p of preds) {
    const [rH, rA] = await Promise.all([client.query(q, [p.home_team_id, p.match_date]), client.query(q, [p.away_team_id, p.match_date])]);
    const strH = calcStr(rH.rows), strA = calcStr(rA.rows);
    const score7 = calcScore7(strH, strA);
    if (score7 == null) s7_null++; else s7_calc++;
    const s1 = N(p.score1), s2 = N(p.score2), s3 = N(p.score3);
    const score6 = calcConvergence([s1, s2, s3, score7]);
    const confN = calcConfidence(s1, s2, s3, score6, score7);
    rezV.push({ conf: N(p.conf_vechi), real: p.result_over15 });
    rezN.push({ conf: confN, real: p.result_over15 });
    if (COMMIT && score7 != null && confN != null) { await client.query('UPDATE predictions SET score7=$1, score6=$2, confidence=$3 WHERE fixture_id=$4', [score7, score6, confN, p.fixture_id]); updated++; }
    processed++;
    if (processed % 100 === 0) process.stdout.write('  ...' + processed + '/' + preds.length + '\r');
  }
  console.log('\n\n-- REZULTAT --');
  console.log('  Procesate: ' + processed);
  console.log('  score7 calculat: ' + s7_calc);
  console.log('  score7 null: ' + s7_null);
  console.log('  UPDATE scrise: ' + (COMMIT ? updated : '0 (DRY-RUN)'));
  const brier = (arr) => { const v = arr.filter(x => okNum(x.conf)); if (!v.length) return null; return v.reduce((s,x)=>s+((x.conf/100)-(x.real?1:0))*((x.conf/100)-(x.real?1:0)),0)/v.length; };
  const bV = brier(rezV), bN = brier(rezN);
  console.log('\n-- CALIBRARE (Brier confidence vs over15, orientativ) --');
  console.log('  Brier VECHI (score7=null): ' + (bV != null ? bV.toFixed(5) : 'n/a'));
  console.log('  Brier NOU   (score7 pit):  ' + (bN != null ? bN.toFixed(5) : 'n/a'));
  if (bV != null && bN != null) { const d = bV - bN; console.log('  Delta: ' + (d>=0?'+':'') + d.toFixed(5) + '  ' + (d>0.001?'-> score7 AJUTA':d<-0.001?'-> score7 INRAUTATESTE':'-> neglijabil')); }
  const buckets = (arr) => { const b = {}; for (const x of arr.filter(y => okNum(y.conf))) { const k = x.conf<55?'1_sub55':x.conf<65?'2_55-64':x.conf<75?'3_65-74':'4_75plus'; if (!b[k]) b[k]={n:0,w:0,c:0}; b[k].n++; b[k].w+=x.real?1:0; b[k].c+=x.conf; } return b; };
  const pr = (lbl, b) => { console.log('\n  ' + lbl + ':'); console.log('    bucket    n     conf_med  over15_real'); for (const k of Object.keys(b).sort()) { const x = b[k]; console.log('    ' + k.padEnd(9) + ' ' + String(x.n).padEnd(5) + ' ' + (x.c/x.n).toFixed(1).padEnd(9) + ' ' + (x.w*100/x.n).toFixed(1) + '%'); } };
  pr('VECHE (score7=null)', buckets(rezV));
  pr('NOUA (score7 pit)', buckets(rezN));
  console.log('\n' + '='.repeat(60));
  await client.end();
}
main().catch(e => { console.error('EROARE:', e.message); process.exit(1); });
