// Cron: GET /api/cron/backfill-predictions
// Backfill RETROACTIV de predicții pentru meciuri FT din fixtures_history (2022+).
// Reutilizează logica EXISTENTĂ din enrich.js (calcPoisson + calcConfidencePreMatch)
// — NU rescrie scoring-ul. DB-ONLY (zero API-Football). Point-in-time: forma/h2h
// se citesc DOAR din meciuri ANTERIOARE datei meciului (fără lookahead).
// ON CONFLICT (fixture_id) DO NOTHING → NU suprascrie predicțiile reale existente.
// Resume: NOT EXISTS skip + LIMIT per rulare. Rulare manuală (heavy, o singură dată/repetat).

import { query } from '../db.js';
import { ALLOWED_LEAGUE_IDS } from '../leagues.js';
import { calcPoisson, calcConfidencePreMatch } from '../enrich.js';

const ALLOWED = [...ALLOWED_LEAGUE_IDS];
const DONE = ['FT', 'AET', 'PEN'];
const BATCH_LIMIT = 20000;   // meciuri procesate per rulare (resume la următoarea)

async function logCron(status, msg = '') {
  try { await query(`INSERT INTO cron_logs (job_name, status, error_msg) VALUES ('backfill-predictions', $1, $2)`, [status, msg || null]); } catch (_) {}
}

// Formă POINT-IN-TIME: ultimele 10 meciuri ale echipei pe venue, ÎNAINTE de dată.
// Shape identic cu getHomeForm/getAwayForm din enrich.js (ce așteaptă calcPoisson).
async function formBefore(teamId, venueCol, beforeDate) {
  const { rows } = await query(
    `SELECT home_team_id, away_team_id, home_goals, away_goals, match_date
       FROM fixtures_history
      WHERE ${venueCol} = $1 AND status_short = ANY($2)
        AND home_goals IS NOT NULL AND match_date < $3
      ORDER BY match_date DESC LIMIT 10`,
    [teamId, DONE, beforeDate]
  );
  return rows.map(r => ({
    teams: { home: { id: r.home_team_id }, away: { id: r.away_team_id } },
    goals: { home: r.home_goals ?? 0, away: r.away_goals ?? 0 },
    match_date: r.match_date,
  }));
}

async function h2hBefore(hId, aId, beforeDate) {
  const { rows } = await query(
    `SELECT home_team_id, away_team_id, home_goals, away_goals, match_date
       FROM fixtures_history
      WHERE ((home_team_id=$1 AND away_team_id=$2) OR (home_team_id=$2 AND away_team_id=$1))
        AND status_short = ANY($3) AND home_goals IS NOT NULL AND match_date < $4
      ORDER BY match_date DESC LIMIT 10`,
    [hId, aId, DONE, beforeDate]
  );
  return rows.map(r => ({
    teams: { home: { id: r.home_team_id }, away: { id: r.away_team_id } },
    goals: { home: r.home_goals ?? 0, away: r.away_goals ?? 0 },
    match_date: r.match_date,
  }));
}

export default async function handler(req, res) {
  let processed = 0, skipped = 0;
  const errors = [];
  const lgStatsCache = new Map();

  try {
    // PASUL 1 — meciuri FT 2022+ neavând încă predicție (resume via NOT EXISTS).
    const { rows: matches } = await query(`
      SELECT fh.fixture_id, fh.home_team_id, fh.away_team_id,
             fh.home_team_name, fh.away_team_name,
             fh.home_goals, fh.away_goals, fh.match_date, fh.league_id,
             eh.home_elo, eh.away_elo, eh.elo_diff, eh.home_win_prob AS elo_home_win_prob
        FROM fixtures_history fh
        LEFT JOIN elo_history eh ON eh.fixture_id = fh.fixture_id
       WHERE fh.match_date >= '2022-01-01' AND fh.match_date < NOW()
         AND fh.home_goals IS NOT NULL AND fh.away_goals IS NOT NULL
         AND fh.home_team_id IS NOT NULL AND fh.away_team_id IS NOT NULL
         AND fh.league_id = ANY($1)
         AND NOT EXISTS (SELECT 1 FROM predictions p WHERE p.fixture_id = fh.fixture_id)
       ORDER BY fh.match_date ASC
       LIMIT $2
    `, [ALLOWED, BATCH_LIMIT]);

    for (const m of matches) {
      try {
        const hId = m.home_team_id, aId = m.away_team_id, lid = m.league_id;
        const hg = Number(m.home_goals), ag = Number(m.away_goals);

        // PASUL 2 — labels din scorul final.
        const result_winner = hg > ag ? 'home' : ag > hg ? 'away' : 'draw';
        const result_over15 = (hg + ag) >= 2;
        const result_over25 = (hg + ag) >= 3;
        const result_gg     = hg > 0 && ag > 0;

        // PASUL 3 — date point-in-time din DB (înainte de match_date).
        const [hGames, aGames, h2h] = await Promise.all([
          formBefore(hId, 'home_team_id', m.match_date),
          formBefore(aId, 'away_team_id', m.match_date),
          h2hBefore(hId, aId, m.match_date),
        ]);
        // Skip meciuri fără niciun semnal (echipe noi, fără istoric înainte de dată).
        if (!hGames.length && !aGames.length) { skipped++; continue; }

        let ls = lgStatsCache.get(lid);
        if (ls === undefined) {
          ls = (await query('SELECT * FROM league_stats WHERE league_id=$1', [lid])).rows[0] || null;
          lgStatsCache.set(lid, ls);
        }

        // PASUL 4 — REUTILIZARE funcții existente (pre-meci: elapsed/goals/sot = 0).
        const result = calcPoisson(hGames, aGames, h2h, hId, aId, 0, 0, 0, 0, 0, undefined, undefined, ls);
        const conf = calcConfidencePreMatch(result, null);   // fără teamStrengths istoric
        const bd = conf.breakdown || {};

        // PASUL 5 — INSERT (FĂRĂ season: predictions nu are coloana). DO NOTHING.
        await query(
          `INSERT INTO predictions (
             fixture_id, league_id, home_team, away_team,
             confidence, over15_prob, over25_prob, gg_prob,
             home_win_prob, draw_prob, away_win_prob,
             score1, score2, score3, score6, score7,
             lambda_home, lambda_away,
             home_elo, away_elo, elo_diff_ml, home_win_prob_elo,
             result_winner, result_over15, result_over25, result_gg,
             match_date, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                   $19,$20,$21,$22,$23,$24,$25,$26,$27,NOW(),NOW())
           ON CONFLICT (fixture_id) DO NOTHING`,
          [
            m.fixture_id, lid, m.home_team_name || '', m.away_team_name || '',
            conf.confidenceScore ?? null,
            result.over15Prob, result.over25Prob, result.ggProb,
            result.homeWin, result.draw, result.awayWin,
            bd.poisson ?? null, bd.forma ?? null, bd.h2h ?? null, bd.consistenta ?? null, bd.putereEchipe ?? null,
            result.lambdaHome, result.lambdaAway,
            m.home_elo ?? null, m.away_elo ?? null, m.elo_diff ?? null, m.elo_home_win_prob ?? null,
            result_winner, result_over15, result_over25, result_gg,
            m.match_date,
          ]
        );
        processed++;
        if (processed % 1000 === 0) console.log(`[backfill-predictions] processed ${processed}/${matches.length}`);
      } catch (e) {
        if (errors.length < 20) errors.push(`fixture ${m.fixture_id}: ${e.message}`);
      }
    }

    const totalRow = await query(`SELECT COUNT(*) AS n FROM predictions WHERE result_winner IS NOT NULL`).catch(() => ({ rows: [{ n: 0 }] }));
    const total_predictions_now = Number(totalRow.rows[0]?.n || 0);

    await logCron(errors.length ? 'error' : 'success',
      `processed:${processed} skipped:${skipped} batch:${matches.length}${errors.length ? ' | ' + errors.slice(0, 5).join(' | ') : ''}`);
    return res.status(200).json({
      ok: true,
      processed,
      skipped,
      errors,
      batch_size: matches.length,
      total_predictions_now,
      note: matches.length === BATCH_LIMIT ? 'Mai sunt meciuri — rulează din nou (resume).' : 'Backfill complet pentru 2022+.',
    });
  } catch (e) {
    await logCron('error', e.message);
    return res.status(500).json({ ok: false, processed, skipped, error: e.message });
  }
}
