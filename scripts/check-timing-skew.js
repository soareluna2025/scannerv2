#!/usr/bin/env node
// scripts/check-timing-skew.js — VERIFICARE anti train/serve skew (READ-ONLY).
//
// Pentru un eșantion de meciuri recente cu timing materializat în ml_features (2a,
// scris de api/cron/build-ml-features.js), RECALCULEAZĂ aceleași features cu expresia
// din api/utils/goal-timing-sql.js rulată standalone (2b, exact ce face api/enrich.js)
// și compară valoare-cu-valoare. Orice diferență > EPS = SKEW (de investigat).
//
// NU scrie nimic (doar SELECT-uri). Rulare pe VPS:
//   node scripts/check-timing-skew.js [--n=200]
import 'dotenv/config';
import { query } from '../api/db.js';
import pool from '../api/db.js';
import { timingBody, TIMING_BASE } from '../api/utils/goal-timing-sql.js';

const SAMPLE = parseInt((process.argv.find(a => a.startsWith('--n=')) || '--n=200').slice(4), 10) || 200;
const EPS = 1e-6;

function eq(a, b) {
  const an = (a === null || a === undefined), bn = (b === null || b === undefined);
  if (an && bn) return true;
  if (an !== bn) return false;
  return Math.abs(Number(a) - Number(b)) <= EPS;
}

async function recompute(teamId, matchDate) {
  if (!teamId || !matchDate) return null;
  const { rows } = await query(timingBody('$1', '$2'), [Number(teamId), matchDate]);
  return rows[0] || null;
}

async function main() {
  const cols = [];
  for (const side of ["home", "away"]) for (const b of TIMING_BASE) cols.push(`mf.${side}_${b}`);
  const { rows } = await query(`
    SELECT mf.fixture_id, fh.match_date, fh.home_team_id, fh.away_team_id,
           ${cols.join(", ")}
    FROM ml_features mf
    JOIN fixtures_history fh ON fh.fixture_id = mf.fixture_id
    WHERE mf.home_tm_scored_r2_rate IS NOT NULL OR mf.away_tm_scored_r2_rate IS NOT NULL
    ORDER BY fh.match_date DESC NULLS LAST
    LIMIT $1`, [SAMPLE]);

  console.log(`check-timing-skew — eșantion ${rows.length} fixturi (ml_features 2a vs enrich/recompute 2b), EPS=${EPS}`);
  if (rows.length === 0) {
    console.log("Nicio fixtură cu timing în ml_features (rulează întâi build-ml-features). STOP.");
    await pool.end(); return;
  }

  let cells = 0, mism = 0, maxDiff = 0;
  const examples = [];
  for (const r of rows) {
    const rh = await recompute(r.home_team_id, r.match_date);
    const ra = await recompute(r.away_team_id, r.match_date);
    for (const [side, rc] of [["home", rh], ["away", ra]]) {
      for (const b of TIMING_BASE) {
        const stored = r[`${side}_${b}`];
        const live = rc ? rc[b] : null;
        cells++;
        if (!eq(stored, live)) {
          mism++;
          const d = (stored == null || live == null) ? Infinity : Math.abs(Number(stored) - Number(live));
          if (Number.isFinite(d) && d > maxDiff) maxDiff = d;
          if (examples.length < 12)
            examples.push(`fid=${r.fixture_id} ${side}_${b}: store=${stored} live=${live}`);
        }
      }
    }
  }

  console.log(`Celule comparate: ${cells} | nepotriviri (>EPS): ${mism} | max |Δ|: ${maxDiff.toFixed(6)}`);
  console.log(mism === 0
    ? "✅ ZERO skew — 2a (ml_features) și 2b (enrich/recompute) produc valori IDENTICE."
    : "❌ SKEW detectat — vezi exemplele de mai jos (build-ml-features vs enrich diferă):");
  for (const e of examples) console.log("  " + e);
  if (mism > examples.length) console.log(`  ... și încă ${mism - examples.length} nepotriviri.`);
  await pool.end();
}

main().catch(async (e) => { console.error("EROARE:", e.message); try { await pool.end(); } catch (_) {} process.exit(1); });
