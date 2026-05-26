// Cron: GET /api/update-results
// Fetches pending predictions (no result yet) and fills in real match outcomes.

import { query } from './db.js';
import { fetchApiFootball } from './utils/fetch-api.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function logCron(status, msg = '') {
  try {
    await query(
      `INSERT INTO cron_logs (job_name, status, error_msg) VALUES ('update-results', $1, $2)`,
      [status, msg || null]
    );
  } catch (_) {}
}

export default async function handler(req, res) {
  const afKey = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;

  if (!afKey) return res.status(500).json({ error: 'API_FOOTBALL_KEY not configured' });

  try {
    // Select predictions without results where match_date has passed
    const pendingRes = await query(
      `SELECT id, fixture_id FROM predictions
       WHERE result_over15 IS NULL AND match_date < NOW()`
    );

    const pending = pendingRes.rows;
    if (!pending.length) {
      await logCron('success', 'no pending');
      return res.status(200).json({ updated: 0, total: 0 });
    }

    let updated = 0;

    for (const pred of pending) {
      try {
        const fr  = await fetchApiFootball(`/fixtures?id=${pred.fixture_id}`);
        const fd  = await fr.json();
        const fix = fd.response?.[0];
        if (!fix) continue;

        const status = fix.fixture?.status?.short;
        if (!['FT', 'AET', 'PEN'].includes(status)) continue;

        const hg = fix.goals?.home;
        const ag = fix.goals?.away;
        if (hg == null || ag == null) continue;

        const pr = await query(
          `UPDATE predictions SET
             result_over15  = $1,
             result_gg      = $2,
             result_winner  = $3,
             updated_at     = NOW()
           WHERE fixture_id = $4`,
          [
            (hg + ag) >= 2,
            hg > 0 && ag > 0,
            hg > ag ? 'home' : ag > hg ? 'away' : 'draw',
            pred.fixture_id,
          ]
        );
        if (pr.rowCount > 0) {
          updated++;
          // Update pre_match_snapshots outcome for back-testing accuracy tracking
          query(
            `UPDATE pre_match_snapshots
             SET outcome = CASE
               WHEN over15_prob >= 55 AND $1 THEN 'WIN'
               WHEN over15_prob < 45  AND NOT $1 THEN 'WIN'
               ELSE 'LOSS'
             END
             WHERE fixture_id = $2 AND outcome IS NULL`,
            [(hg + ag) >= 2, pred.fixture_id]
          ).catch(() => {});

          // Resolve prediction_log outcomes for self-learning
          const isOver15 = (hg + ag) >= 2;
          const isOver25 = (hg + ag) >= 3;
          const isGG     = hg > 0 && ag > 0;

          // Resolve OVER15 predictions
          query(`UPDATE prediction_log SET outcome=CASE WHEN $1 THEN 'WIN' ELSE 'LOSS' END, actual_value=$2, resolved_at=NOW() WHERE fixture_id=$3 AND module='OVER15' AND outcome='PENDING'`,
            [isOver15, hg + ag, pred.fixture_id]).catch(() => {});
          // Resolve OVER25
          query(`UPDATE prediction_log SET outcome=CASE WHEN $1 THEN 'WIN' ELSE 'LOSS' END, actual_value=$2, resolved_at=NOW() WHERE fixture_id=$3 AND module='OVER25' AND outcome='PENDING'`,
            [isOver25, hg + ag, pred.fixture_id]).catch(() => {});
          // Resolve GG
          query(`UPDATE prediction_log SET outcome=CASE WHEN $1 THEN 'WIN' ELSE 'LOSS' END, actual_value=$2, resolved_at=NOW() WHERE fixture_id=$3 AND module='GG' AND outcome='PENDING'`,
            [isGG, isGG ? 1 : 0, pred.fixture_id]).catch(() => {});
          // Resolve CONFIDENCE — WIN if over15 was correct (same logic as pre_match_snapshots)
          query(`UPDATE prediction_log SET outcome=CASE WHEN (predicted_value>=55 AND $1) OR (predicted_value<45 AND NOT $1) THEN 'WIN' ELSE 'LOSS' END, actual_value=$2, resolved_at=NOW() WHERE fixture_id=$3 AND module='CONFIDENCE' AND outcome='PENDING'`,
            [isOver15, hg + ag, pred.fixture_id]).catch(() => {});
          // Resolve NGP — WIN if total goals at end > total goals at prediction time
          query(`UPDATE prediction_log SET
            outcome=CASE WHEN $1 > CAST(SPLIT_PART(score_at_prediction,'-',1) AS INT) + CAST(SPLIT_PART(score_at_prediction,'-',2) AS INT) THEN 'WIN' ELSE 'LOSS' END,
            actual_value=$1, resolved_at=NOW()
            WHERE fixture_id=$2 AND module='NGP' AND outcome='PENDING'`,
            [hg + ag, pred.fixture_id]).catch(() => {});
        }
      } catch (_) { /* skip fixture, try next */ }
      // M4: 500ms pauza intre requesturi pentru a nu satura API-ul
      await sleep(500);
    }

    await logCron('success', `updated ${updated}/${pending.length}`);
    return res.status(200).json({ updated, total: pending.length });
  } catch (e) {
    await logCron('error', e.message);
    return res.status(500).json({ error: e.message });
  }
}
