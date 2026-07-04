// scripts/pit-recompute.js — Faza 2: recompute POINT-IN-TIME score7/score6/confidence
// în ml_features (pit_score7/pit_score6/pit_confidence/pit_players_n).
//
// Anti-leakage STRICT: puterea echipei se agregă DOAR din player_stats ale meciurilor cu
// match_date < data fixture-ului curent (fereastră ≤110 rânduri, cele mai recente anterioare).
//
// EFICIENT: NU face N+1 per fixture. Agregarea top-110/echipă rulează într-o SINGURĂ
// interogare/batch (2× LATERAL în SQL), arithmetica finală (identică cu enrich.js) în JS,
// iar scrierea = 1 UPDATE/batch (UNNEST de array-uri). RELUABIL: procesează doar rândurile
// cu pit_players_n IS NULL (marker de procesare), deci reluarea nu reface munca.
//
// Formule REPLICATE VERBATIM din enrich.js (imutabile, NU modificate acolo):
//   calcStr (getTeamStrengths, enrich.js:459-475), calcScore7 (enrich.js:589-592),
//   calcConvergence (score6, enrich.js:599-606), calcConfidence (0.30/0.25/0.15/0.25/0.05,
//   enrich.js:661-666). s1/s2/s3 vin din predictions (ml_features NU le stochează).
//
// Rulare:
//   dry:  cd /root/scannerv2 && node scripts/pit-recompute.js --years=2022-2025 --dry-run
//   real: cd /root/scannerv2 && nohup node scripts/pit-recompute.js --years=2022-2025 --batch=1000 >> logs/pit-recompute.log 2>&1 &
import 'dotenv/config';
import { query } from '../api/db.js';
import pool from '../api/db.js';

const args = process.argv.slice(2);
const getArg = (n, d) => { const a = args.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : d; };
const DRY = args.includes('--dry-run');
const BATCH = parseInt(getArg('batch', '1000'), 10);
const MAX_BATCHES = parseInt(getArg('max-batches', '0'), 10); // 0 = fără cap
const yearsArg = getArg('years', '2022-2025');
const [Y0, Y1] = (() => {
  const m = String(yearsArg).match(/^(\d{4})(?:-(\d{4}))?$/);
  if (!m) { console.error('❌ --years=YYYY sau YYYY-YYYY'); process.exit(1); }
  return [parseInt(m[1], 10), parseInt(m[2] || m[1], 10)];
})();

const N = (v) => v == null ? null : Number(v);

// ── Formule VERBATIM din validat/enrich.js ────────────────────────────────────
// calcStr, dar din agregatele calculate în SQL peste ACEEAȘI fereastră top-110.
function calcStrFromAgg(a) {
  if (!a || Number(a.n) < 10) return null;                 // <10 rânduri → null (ca prod)
  const n = Number(a.n);
  const avgRating   = Number(a.n_rating) > 0 ? Number(a.avg_rating) : 5;
  const goalsPerGame = Number(a.goals_sum) / n;
  const avgPassAcc  = Number(a.n_pass) > 0 ? Number(a.avg_pass) : 50;
  const avgSot      = Number(a.sot_sum) / n;
  const topScorer   = Number(a.top_scorer) || 0;
  return Math.round((avgRating / 10 * 100) * 0.35 + Math.min(100, goalsPerGame * 35) * 0.25
    + avgPassAcc * 0.20 + Math.min(100, avgSot * 12) * 0.10 + Math.min(100, topScorer * 20) * 0.10);
}
function calcScore7(h, a) {
  if (h == null && a == null) return null;
  const hs = h == null ? 50 : h, as = a == null ? 50 : a;
  const hd = hs * (100 - as) / 100, ad = as * (100 - hs) / 100;
  return Math.max(0, Math.min(100, Math.round((hd + ad) / 2 * 1.5)));
}
function calcConvergence(all) {
  const act = all.filter(v => v != null && !isNaN(v));
  if (act.length < 2) return null;
  const m = act.reduce((s, v) => s + v, 0) / act.length;
  const va = act.reduce((s, v) => s + (v - m) * (v - m), 0) / act.length;
  return Math.round(Math.max(0, Math.min(100, 100 - Math.sqrt(va))));
}
function calcConfidence(s1, s2, s3, s6, s7) {
  const L = [{ s: s1, w: 0.30 }, { s: s2, w: 0.25 }, { s: s3, w: 0.15 }, { s: s7, w: 0.25 }, { s: s6, w: 0.05 }];
  const f = L.filter(l => l.s !== null && !isNaN(l.s) && l.w > 0);
  const tw = f.reduce((s, l) => s + l.w, 0);
  if (tw === 0) return null;
  return Math.max(5, Math.min(100, Math.round(f.reduce((s, l) => s + l.s * (l.w / tw), 0))));
}

// Un LATERAL de agregare top-110 point-in-time pentru o coloană de echipă dată.
const teamAgg = (teamCol, alias) => `
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS n, COUNT(w.rating) AS n_rating, AVG(w.rating) AS avg_rating,
           SUM(COALESCE(w.goals,0)) AS goals_sum, COUNT(w.pass_accuracy) AS n_pass,
           AVG(w.pass_accuracy) AS avg_pass, SUM(COALESCE(w.shots_on_target,0)) AS sot_sum,
           MAX(COALESCE(w.goals,0)) AS top_scorer
    FROM (
      SELECT ps.rating, ps.goals, ps.pass_accuracy, ps.shots_on_target
      FROM player_stats ps
      JOIN fixtures_history fhh ON fhh.fixture_id = ps.fixture_id
      WHERE ps.team_id = fh.${teamCol} AND fhh.match_date < fh.match_date
      ORDER BY fhh.match_date DESC
      LIMIT 110
    ) w
  ) ${alias} ON TRUE`;

const SELECT_SQL = `
  SELECT mf.fixture_id, fh.match_date,
         p.score1, p.score2, p.score3,
         h.n AS h_n, h.n_rating AS h_nr, h.avg_rating AS h_ar, h.goals_sum AS h_gs,
         h.n_pass AS h_np, h.avg_pass AS h_ap, h.sot_sum AS h_ss, h.top_scorer AS h_ts,
         a.n AS a_n, a.n_rating AS a_nr, a.avg_rating AS a_ar, a.goals_sum AS a_gs,
         a.n_pass AS a_np, a.avg_pass AS a_ap, a.sot_sum AS a_ss, a.top_scorer AS a_ts
  FROM ml_features mf
  JOIN fixtures_history fh ON fh.fixture_id = mf.fixture_id
  LEFT JOIN predictions p ON p.fixture_id = mf.fixture_id
  ${teamAgg('home_team_id', 'h')}
  ${teamAgg('away_team_id', 'a')}
  WHERE mf.pit_players_n IS NULL
    AND date_part('year', fh.match_date) BETWEEN $1 AND $2
    AND fh.home_team_id IS NOT NULL AND fh.away_team_id IS NOT NULL
  ORDER BY fh.match_date
  LIMIT $3`;

async function main() {
  if (!process.env.POSTGRES_URL) { console.error('❌ POSTGRES_URL lipsește (rulează din /root/scannerv2)'); process.exit(1); }
  const stamp = () => new Date().toISOString();
  console.log(`[pit-recompute] start ${stamp()} | ani ${Y0}-${Y1} | batch ${BATCH} | ${DRY ? 'DRY-RUN' : 'COMMIT'}`);

  let totalProc = 0, totalS7 = 0, totalNull = 0, batches = 0;
  const startTs = Date.now();

  while (true) {
    if (MAX_BATCHES && batches >= MAX_BATCHES) { console.log(`[pit-recompute] cap max-batches=${MAX_BATCHES} atins.`); break; }
    const { rows } = await query(SELECT_SQL, [Y0, Y1, BATCH]);
    if (!rows.length) { console.log('[pit-recompute] selecție goală — gata.'); break; }

    const fx = [], as7 = [], as6 = [], aconf = [], an = [];
    for (const r of rows) {
      const strH = calcStrFromAgg({ n: r.h_n, n_rating: r.h_nr, avg_rating: r.h_ar, goals_sum: r.h_gs, n_pass: r.h_np, avg_pass: r.h_ap, sot_sum: r.h_ss, top_scorer: r.h_ts });
      const strA = calcStrFromAgg({ n: r.a_n, n_rating: r.a_nr, avg_rating: r.a_ar, goals_sum: r.a_gs, n_pass: r.a_np, avg_pass: r.a_ap, sot_sum: r.a_ss, top_scorer: r.a_ts });
      const s7 = calcScore7(strH, strA);
      const s1 = N(r.score1), s2 = N(r.score2), s3 = N(r.score3);
      const hasPreds = s1 != null || s2 != null || s3 != null;
      const s6 = hasPreds ? calcConvergence([s1, s2, s3, s7]) : null;
      const conf = hasPreds ? calcConfidence(s1, s2, s3, s6, s7) : null;
      const playersN = Math.min(Number(r.h_n) || 0, Number(r.a_n) || 0);
      if (s7 == null) totalNull++; else totalS7++;
      fx.push(r.fixture_id); as7.push(s7); as6.push(s6); aconf.push(conf); an.push(playersN);
    }

    if (!DRY) {
      await query(
        `UPDATE ml_features mf SET
           pit_score7 = d.s7, pit_score6 = d.s6, pit_confidence = d.conf, pit_players_n = d.n
         FROM (SELECT UNNEST($1::int[]) AS fixture_id, UNNEST($2::numeric[]) AS s7,
                      UNNEST($3::numeric[]) AS s6, UNNEST($4::numeric[]) AS conf,
                      UNNEST($5::smallint[]) AS n) d
         WHERE mf.fixture_id = d.fixture_id`,
        [fx, as7, as6, aconf, an]
      );
    }

    totalProc += rows.length; batches++;
    const el = (Date.now() - startTs) / 1000;
    console.log(`[pit-recompute] batch ${batches}: +${rows.length} (total ${totalProc}) · s7=${totalS7} null=${totalNull} · ${(totalProc / (el || 1)).toFixed(0)} fx/s${DRY ? ' · DRY (fără UPDATE)' : ''}`);
    if (DRY) { console.log('[pit-recompute] DRY-RUN — un singur batch, fără scriere.'); break; }
  }

  const el = (Date.now() - startTs) / 1000;
  console.log(`\n[pit-recompute] GATA ${stamp()} · procesate ${totalProc} · pit_score7 non-null ${totalS7} · null ${totalNull} · ${el.toFixed(0)}s`);
  console.log('[pit-recompute] reluabil: rerulează aceeași comandă (procesează doar pit_players_n IS NULL).');
  await pool.end();
}
main().catch(async (e) => { console.error('[pit-recompute] EROARE:', e.message); try { await pool.end(); } catch (_) {} process.exit(1); });
