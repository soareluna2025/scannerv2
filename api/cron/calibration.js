import { query } from '../db.js';

async function logCron(fixtures, leagues, status, errorMsg) {
  try {
    await query(
      `INSERT INTO cron_logs (job_name, fixtures_processed, players_upserted, status, error_msg)
       VALUES ($1,$2,$3,$4,$5)`,
      ['calibration', fixtures, leagues, status, errorMsg || null]
    );
  } catch (_) {}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    // Ensure prediction_calibration table exists
    await query(`
      CREATE TABLE IF NOT EXISTS prediction_calibration (
        league_id                 INTEGER PRIMARY KEY,
        league_name               TEXT,
        calibration_factor_over15 NUMERIC DEFAULT 1.0,
        calibration_factor_over25 NUMERIC DEFAULT 1.0,
        calibration_factor_gg     NUMERIC DEFAULT 1.0,
        total_matches             INTEGER DEFAULT 0,
        correct_over15            INTEGER DEFAULT 0,
        correct_over25            INTEGER DEFAULT 0,
        correct_gg                INTEGER DEFAULT 0,
        avg_predicted_over15      NUMERIC,
        avg_predicted_over25      NUMERIC,
        avg_predicted_gg          NUMERIC,
        accuracy_over15           NUMERIC,
        accuracy_over25           NUMERIC,
        accuracy_gg               NUMERIC,
        last_updated              TIMESTAMP DEFAULT NOW()
      )
    `);

    // Ensure predictions has result columns for over25 and gg (over15 already exists)
    await query(`ALTER TABLE predictions ADD COLUMN IF NOT EXISTS result_over25 BOOLEAN`);
    await query(`ALTER TABLE predictions ADD COLUMN IF NOT EXISTS result_gg BOOLEAN`);

    // Read FT predictions from last 2 seasons joined with actual results
    const { rows: matches } = await query(`
      SELECT
        p.fixture_id,
        p.league_id,
        p.league_name,
        p.over15_prob,
        p.over25_prob,
        p.gg_prob,
        fh.home_goals,
        fh.away_goals
      FROM predictions p
      JOIN fixtures_history fh ON fh.fixture_id = p.fixture_id
      WHERE fh.status_short = 'FT'
        AND fh.home_goals IS NOT NULL
        AND fh.away_goals IS NOT NULL
        AND p.league_id IS NOT NULL
        AND p.over15_prob IS NOT NULL
        AND p.over25_prob IS NOT NULL
        AND p.gg_prob IS NOT NULL
        AND EXTRACT(YEAR FROM fh.match_date) >= (EXTRACT(YEAR FROM NOW()) - 2)
    `).catch(() => ({ rows: [] }));

    if (!matches.length) {
      await logCron(0, 0, 'ok', null);
      return res.status(200).json({
        ok: true,
        message: 'No predictions with FT results found',
        leagues_updated: 0,
      });
    }

    // Group by league
    const leagueMap = new Map();
    for (const m of matches) {
      const lid = m.league_id;
      if (!leagueMap.has(lid)) {
        leagueMap.set(lid, { league_id: lid, league_name: m.league_name || '', matches: [] });
      }
      leagueMap.get(lid).matches.push(m);
    }

    let leaguesUpdated = 0;
    const MIN_MATCHES = 50;

    for (const [lid, league] of leagueMap) {
      if (league.matches.length < MIN_MATCHES) continue;

      let correct15 = 0, correct25 = 0, correctGG = 0;
      let sumPred15 = 0, sumPred25 = 0, sumPredGG = 0;
      const total = league.matches.length;

      for (const m of league.matches) {
        const totalGoals = Number(m.home_goals) + Number(m.away_goals);
        const bothScored = Number(m.home_goals) > 0 && Number(m.away_goals) > 0;

        if (totalGoals > 1) correct15++;
        if (totalGoals > 2) correct25++;
        if (bothScored)     correctGG++;

        sumPred15 += parseFloat(m.over15_prob) || 0;
        sumPred25 += parseFloat(m.over25_prob) || 0;
        sumPredGG += parseFloat(m.gg_prob)     || 0;
      }

      const acc15 = correct15 / total;
      const acc25 = correct25 / total;
      const accGG = correctGG / total;

      // avg predicted probability as fraction (0–1)
      const avgP15 = sumPred15 / total / 100;
      const avgP25 = sumPred25 / total / 100;
      const avgPGG = sumPredGG / total / 100;

      // factor = actual_accuracy / avg_predicted_prob; capped 0.5–2.0; neutral if no data
      const f15 = avgP15 > 0 ? Math.max(0.5, Math.min(2.0, acc15 / avgP15)) : 1.0;
      const f25 = avgP25 > 0 ? Math.max(0.5, Math.min(2.0, acc25 / avgP25)) : 1.0;
      const fGG = avgPGG > 0 ? Math.max(0.5, Math.min(2.0, accGG / avgPGG)) : 1.0;

      await query(`
        INSERT INTO prediction_calibration (
          league_id, league_name,
          calibration_factor_over15, calibration_factor_over25, calibration_factor_gg,
          total_matches, correct_over15, correct_over25, correct_gg,
          avg_predicted_over15, avg_predicted_over25, avg_predicted_gg,
          accuracy_over15, accuracy_over25, accuracy_gg,
          last_updated
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
        ON CONFLICT (league_id) DO UPDATE SET
          league_name                = EXCLUDED.league_name,
          calibration_factor_over15  = EXCLUDED.calibration_factor_over15,
          calibration_factor_over25  = EXCLUDED.calibration_factor_over25,
          calibration_factor_gg      = EXCLUDED.calibration_factor_gg,
          total_matches              = EXCLUDED.total_matches,
          correct_over15             = EXCLUDED.correct_over15,
          correct_over25             = EXCLUDED.correct_over25,
          correct_gg                 = EXCLUDED.correct_gg,
          avg_predicted_over15       = EXCLUDED.avg_predicted_over15,
          avg_predicted_over25       = EXCLUDED.avg_predicted_over25,
          avg_predicted_gg           = EXCLUDED.avg_predicted_gg,
          accuracy_over15            = EXCLUDED.accuracy_over15,
          accuracy_over25            = EXCLUDED.accuracy_over25,
          accuracy_gg                = EXCLUDED.accuracy_gg,
          last_updated               = NOW()
      `, [
        lid, league.league_name,
        parseFloat(f15.toFixed(4)),
        parseFloat(f25.toFixed(4)),
        parseFloat(fGG.toFixed(4)),
        total, correct15, correct25, correctGG,
        parseFloat((avgP15 * 100).toFixed(2)),
        parseFloat((avgP25 * 100).toFixed(2)),
        parseFloat((avgPGG * 100).toFixed(2)),
        parseFloat((acc15 * 100).toFixed(2)),
        parseFloat((acc25 * 100).toFixed(2)),
        parseFloat((accGG * 100).toFixed(2)),
      ]);

      leaguesUpdated++;
    }

    await logCron(matches.length, leaguesUpdated, 'ok', null);
    return res.status(200).json({
      ok: true,
      total_predictions: matches.length,
      leagues_total: leagueMap.size,
      leagues_updated: leaguesUpdated,
      leagues_skipped_min50: leagueMap.size - leaguesUpdated,
    });
  } catch (e) {
    await logCron(0, 0, 'error', e.message);
    return res.status(500).json({ error: e.message });
  }
}
