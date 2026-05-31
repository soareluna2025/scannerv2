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

// Rezolvă prediction_log DIRECT din fixtures_history (0 apeluri API, set-based).
// Independent de tabela `predictions` — acoperă predicțiile log-uite separat
// (NGP/CONFIDENCE din scanner) și backlog-ul istoric, indiferent de data predicției.
// Înainte: prediction_log se rezolva DOAR ca efect secundar al loop-ului pe
// `predictions` (gated pe pr.rowCount>0) → 1.831 rămâneau PENDING deși meciul era FT.
async function resolvePredictionLogFromHistory() {
  const ft = `fh.status_short IN ('FT','AET','PEN') AND fh.home_goals IS NOT NULL AND fh.away_goals IS NOT NULL`;
  const base = (mod, setClause) => `
    UPDATE prediction_log pl SET ${setClause}, resolved_at=NOW()
    FROM fixtures_history fh
    WHERE pl.fixture_id = fh.fixture_id
      AND pl.outcome = 'PENDING'
      AND pl.module = '${mod}'
      AND ${ft}`;
  const counts = {};
  let r;

  r = await query(base('OVER15',
    `outcome=CASE WHEN (fh.home_goals+fh.away_goals)>=2 THEN 'WIN' ELSE 'LOSS' END,
     actual_value=fh.home_goals+fh.away_goals`));
  counts.OVER15 = r.rowCount;

  r = await query(base('OVER25',
    `outcome=CASE WHEN (fh.home_goals+fh.away_goals)>=3 THEN 'WIN' ELSE 'LOSS' END,
     actual_value=fh.home_goals+fh.away_goals`));
  counts.OVER25 = r.rowCount;

  r = await query(base('GG',
    `outcome=CASE WHEN fh.home_goals>0 AND fh.away_goals>0 THEN 'WIN' ELSE 'LOSS' END,
     actual_value=CASE WHEN fh.home_goals>0 AND fh.away_goals>0 THEN 1 ELSE 0 END`));
  counts.GG = r.rowCount;

  // CONFIDENCE — aceeași regulă direcțională ca în loop-ul existent (predicted_value)
  r = await query(base('CONFIDENCE',
    `outcome=CASE WHEN (pl.predicted_value>=55 AND (fh.home_goals+fh.away_goals)>=2)
                    OR (pl.predicted_value<45  AND (fh.home_goals+fh.away_goals)<2)
                  THEN 'WIN' ELSE 'LOSS' END,
     actual_value=fh.home_goals+fh.away_goals`));
  counts.CONFIDENCE = r.rowCount;

  // NGP — WIN dacă totalul final > totalul la momentul predicției (din score_at_prediction).
  // Guard regex '^d+-d+$': sărim rândurile fără scor valid (altfel CAST ar pica tot UPDATE-ul).
  r = await query(`
    UPDATE prediction_log pl SET
      outcome=CASE WHEN (fh.home_goals+fh.away_goals) >
        (CAST(SPLIT_PART(pl.score_at_prediction,'-',1) AS INT) +
         CAST(SPLIT_PART(pl.score_at_prediction,'-',2) AS INT))
        THEN 'WIN' ELSE 'LOSS' END,
      actual_value=fh.home_goals+fh.away_goals, resolved_at=NOW()
    FROM fixtures_history fh
    WHERE pl.fixture_id = fh.fixture_id
      AND pl.outcome = 'PENDING'
      AND pl.module = 'NGP'
      AND pl.score_at_prediction ~ '^[0-9]+-[0-9]+$'
      AND ${ft}`);
  counts.NGP = r.rowCount;

  const total = Object.values(counts).reduce((a, b) => a + (b || 0), 0);
  return { counts, total };
}

// TASK1 — rezolvă tabela `predictions` DIRECT din fixtures_history (DB, 0 API).
// Înainte: update-results rezolva predictions DOAR prin API (1 call/fixture) →
// rate-limit / meciuri încă neterminate → „updated 7/22". Acum meciurile deja FT
// în history se rezolvă set-based, fără API; loop-ul API tratează doar restul.
async function resolvePredictionsFromHistory() {
  const r = await query(`
    UPDATE predictions p SET
      result_over15 = (fh.home_goals + fh.away_goals) >= 2,
      result_over25 = (fh.home_goals + fh.away_goals) >= 3,
      result_gg     = (fh.home_goals > 0 AND fh.away_goals > 0),
      result_winner = CASE WHEN fh.home_goals > fh.away_goals THEN 'home'
                           WHEN fh.away_goals > fh.home_goals THEN 'away' ELSE 'draw' END,
      updated_at = NOW()
    FROM fixtures_history fh
    WHERE p.fixture_id = fh.fixture_id
      AND p.result_over15 IS NULL
      AND fh.status_short IN ('FT','AET','PEN')
      AND fh.home_goals IS NOT NULL AND fh.away_goals IS NOT NULL
  `);
  return r.rowCount || 0;
}

export default async function handler(req, res) {
  const afKey = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;

  if (!afKey) return res.status(500).json({ error: 'API_FOOTBALL_KEY not configured' });

  try {
    // ── PASUL 0: rezolvă prediction_log din fixtures_history (DB, 0 API).
    // Rulează ÎNTOTDEAUNA primul → curăță backlog-ul (1.831) + cazurile noi,
    // indiferent dacă există rânduri pending în tabela `predictions`.
    let plResolved = { counts: {}, total: 0 };
    try {
      plResolved = await resolvePredictionLogFromHistory();
      console.log(`[update-results] prediction_log rezolvate din history: ${plResolved.total}`, plResolved.counts);
    } catch (e) {
      console.error('[update-results] resolvePredictionLogFromHistory:', e.message);
    }

    // ── PASUL 0.5: rezolvă predictions din fixtures_history (DB, 0 API) ÎNAINTE
    // de loop-ul API → meciurile deja FT nu mai consumă call-uri / nu mai sunt
    // „sărite" din cauza rate-limit. Loop-ul API tratează doar restul.
    let predFromHistory = 0;
    try {
      predFromHistory = await resolvePredictionsFromHistory();
      console.log(`[update-results] predictions rezolvate din history: ${predFromHistory}`);
    } catch (e) {
      console.error('[update-results] resolvePredictionsFromHistory:', e.message);
    }

    // Select predictions without results where match_date has passed
    const pendingRes = await query(
      `SELECT id, fixture_id FROM predictions
       WHERE result_over15 IS NULL AND match_date < NOW()`
    );

    const pending = pendingRes.rows;
    if (!pending.length) {
      await logCron('success', `no pending; fromHistory ${predFromHistory}; prediction_log resolved ${plResolved.total}`);
      return res.status(200).json({ updated: 0, from_history: predFromHistory, total: 0, prediction_log_resolved: plResolved.total, prediction_log_by_module: plResolved.counts });
    }

    let updated = 0;
    let skipped = 0;

    for (const pred of pending) {
      try {
        const fr  = await fetchApiFootball(`/fixtures?id=${pred.fixture_id}`);
        const fd  = await fr.json();
        const fix = fd.response?.[0];
        if (!fix) { skipped++; console.log(`[update-results] skip ${pred.fixture_id}: API răspuns gol (rate-limit?)`); continue; }

        const status = fix.fixture?.status?.short;
        if (!['FT', 'AET', 'PEN'].includes(status)) { skipped++; console.log(`[update-results] skip ${pred.fixture_id}: status=${status} (încă neterminat)`); continue; }

        const hg = fix.goals?.home;
        const ag = fix.goals?.away;
        if (hg == null || ag == null) { skipped++; console.log(`[update-results] skip ${pred.fixture_id}: scor null`); continue; }

        const pr = await query(
          `UPDATE predictions SET
             result_over15  = $1,
             result_over25  = $2,
             result_gg      = $3,
             result_winner  = $4,
             updated_at     = NOW()
           WHERE fixture_id = $5`,
          [
            (hg + ag) >= 2,
            (hg + ag) >= 3,
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

    await logCron('success', `updated ${updated}/${pending.length} (api); fromHistory ${predFromHistory}; skipped ${skipped}; prediction_log resolved ${plResolved.total}`);
    return res.status(200).json({
      updated,
      from_history: predFromHistory,
      skipped,
      total: pending.length,
      prediction_log_resolved: plResolved.total,
      prediction_log_by_module: plResolved.counts,
    });
  } catch (e) {
    await logCron('error', e.message);
    return res.status(500).json({ error: e.message });
  }
}
