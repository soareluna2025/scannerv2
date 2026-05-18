import { query } from './db.js';

// Read-only debug endpoint — returns predefined DB stats, no user input accepted.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const [
      fixturesByStatus,
      fixturesTotal,
      predictions,
      playerStats,
      matchSnapshots,
      liveStats,
      alerts,
      cronLogs,
      recentFixtures,
      ngpWR,
    ] = await Promise.all([
      query(`SELECT status_short, COUNT(*) AS cnt
             FROM fixtures_history GROUP BY status_short ORDER BY cnt DESC`),
      query(`SELECT COUNT(*) AS cnt FROM fixtures_history`),
      query(`SELECT COUNT(*) AS cnt FROM predictions`),
      query(`SELECT COUNT(*) AS cnt FROM player_stats`),
      query(`SELECT COUNT(*) AS cnt, COUNT(*) FILTER (WHERE outcome='LIVE') AS live
             FROM match_snapshots`),
      query(`SELECT COUNT(*) AS cnt FROM live_stats`),
      query(`SELECT COUNT(*) AS cnt FROM alerts`),
      query(`SELECT job_name, ran_at, status, fixtures_processed, players_upserted, error_msg
             FROM cron_logs ORDER BY ran_at DESC LIMIT 10`),
      query(`SELECT fixture_id, home_team_id, away_team_id, status_short, match_date
             FROM fixtures_history ORDER BY match_date DESC LIMIT 5`),
      query(`SELECT
               COUNT(*) FILTER (WHERE outcome_ngp='WIN'     AND DATE(updated_at) = CURRENT_DATE) AS wins,
               COUNT(*) FILTER (WHERE outcome_ngp='LOSS'    AND DATE(updated_at) = CURRENT_DATE) AS losses,
               COUNT(*) FILTER (WHERE outcome_ngp='PENDING' AND DATE(match_date) = CURRENT_DATE) AS pending,
               COUNT(*) FILTER (WHERE outcome_ngp IN ('WIN','LOSS') AND DATE(updated_at) = CURRENT_DATE) AS resolved
             FROM predictions
             WHERE score_at_alert IS NOT NULL`),
    ]);

    res.status(200).json({
      ok: true,
      ts: new Date().toISOString(),
      fixtures_history: {
        total:    Number(fixturesTotal.rows[0].cnt),
        byStatus: Object.fromEntries(
          fixturesByStatus.rows.map(r => [r.status_short, Number(r.cnt)])
        ),
        recent: recentFixtures.rows,
      },
      predictions:    Number(predictions.rows[0].cnt),
      playerStats:    Number(playerStats.rows[0].cnt),
      matchSnapshots: {
        total: Number(matchSnapshots.rows[0].cnt),
        live:  Number(matchSnapshots.rows[0].live),
      },
      liveStats:  Number(liveStats.rows[0].cnt),
      alerts: Number(alerts.rows[0].cnt),
      cronLogs: cronLogs.rows,
      ngpWinRate: (() => {
        const r = ngpWR.rows[0] || {};
        const w = Number(r.wins    || 0);
        const l = Number(r.losses  || 0);
        const p = Number(r.pending || 0);
        const resolved = Number(r.resolved || 0);
        return { w, l, p, resolved, rate: resolved > 0 ? Math.round(w / resolved * 100) : null };
      })(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
