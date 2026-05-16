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
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
