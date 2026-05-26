#!/usr/bin/env node
// Generează retroactiv înregistrări în `predictions` din fixtures_history + form_stats.
// Scopul: crește sample-ul pentru recalibrate-tables (Brier score).
// Rulează manual: node scripts/backfill-predictions.js [--limit 500]

import 'dotenv/config';
import { query } from '../api/db.js';
import { calcPoisson6x6 } from '../api/calc-utils.js';

const BATCH   = 100;
const LIMIT   = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0') || 5000;
const DRY_RUN = process.argv.includes('--dry');

function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }

async function getFormStats(teamId) {
  const r = await query(
    `SELECT avg_scored_home, avg_conceded_home, avg_scored_away, avg_conceded_away
     FROM form_stats WHERE team_id=$1
     ORDER BY updated_at DESC LIMIT 1`,
    [teamId]
  );
  return r.rows[0] || null;
}

function poissonCalc(homeForm, awayForm) {
  const hScored    = parseFloat(homeForm.avg_scored_home)   || 1.2;
  const hConceded  = parseFloat(homeForm.avg_conceded_home) || 1.0;
  const aScored    = parseFloat(awayForm.avg_scored_away)   || 1.0;
  const aConceded  = parseFloat(awayForm.avg_conceded_away) || 1.2;

  const lambdaHome  = (hScored + aConceded) / 2;
  const lambdaAway  = (aScored + hConceded) / 2;
  const matrix      = calcPoisson6x6(lambdaHome, lambdaAway);

  return { lambdaHome, lambdaAway, matrix };
}

async function main() {
  log(`Start — limit=${LIMIT}, dry=${DRY_RUN}`);

  // Meciuri din fixtures_history care NU există deja în predictions
  const { rows: fixtures } = await query(`
    SELECT fh.fixture_id,
           fh.home_team_id, fh.home_team_name,
           fh.away_team_id, fh.away_team_name,
           fh.league_id, fh.season,
           fh.home_goals, fh.away_goals,
           fh.match_date
    FROM fixtures_history fh
    WHERE fh.home_goals IS NOT NULL
      AND fh.away_goals IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM predictions p WHERE p.fixture_id = fh.fixture_id
      )
    ORDER BY fh.match_date DESC
    LIMIT $1
  `, [LIMIT]);

  log(`Găsite ${fixtures.length} meciuri fără predicție`);

  let inserted = 0, skipped = 0;

  for (let i = 0; i < fixtures.length; i += BATCH) {
    const batch = fixtures.slice(i, i + BATCH);

    for (const f of batch) {
      const [homeForm, awayForm] = await Promise.all([
        getFormStats(f.home_team_id),
        getFormStats(f.away_team_id),
      ]);

      if (!homeForm || !awayForm) { skipped++; continue; }

      const { lambdaHome, lambdaAway, matrix } = poissonCalc(homeForm, awayForm);

      const totalGoals = (f.home_goals || 0) + (f.away_goals || 0);
      const result_over15 = totalGoals > 1;
      const result_over25 = totalGoals > 2;
      const result_gg     = (f.home_goals || 0) > 0 && (f.away_goals || 0) > 0;
      const result_1x2    = f.home_goals > f.away_goals ? 'H'
                          : f.home_goals < f.away_goals ? 'A' : 'D';

      if (DRY_RUN) { inserted++; continue; }

      await query(`
        INSERT INTO predictions
          (fixture_id, home_team, away_team, league_id, match_date,
           lambda_home, lambda_away, lambda_total,
           over15_prob, over25_prob, gg_prob,
           home_win_prob, draw_prob, away_win_prob,
           result_over15, result_over25, result_gg, result_1x2)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT (fixture_id) DO NOTHING
      `, [
        f.fixture_id,
        f.home_team_name, f.away_team_name,
        f.league_id, f.match_date,
        +lambdaHome.toFixed(3), +lambdaAway.toFixed(3), +(lambdaHome + lambdaAway).toFixed(3),
        matrix.over15Prob, matrix.over25Prob, matrix.ggProb,
        matrix.homeWin, matrix.draw, matrix.awayWin,
        result_over15, result_over25, result_gg, result_1x2,
      ]);
      inserted++;
    }

    log(`Progres: ${Math.min(i + BATCH, fixtures.length)}/${fixtures.length} — insertat=${inserted}, sărit=${skipped}`);
  }

  log(`Gata. Insertat=${inserted}, sărit (form_stats lipsă)=${skipped}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
