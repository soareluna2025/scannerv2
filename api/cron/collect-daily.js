// api/cron/collect-daily.js
// Rulează zilnic la 06:00
// Colectează: standings, leagues, teams pentru toate ligile din whitelist

import { query } from '../db.js';
import { ALLOWED_LEAGUE_IDS } from '../leagues.js';

const PRIORITY_LEAGUES = [...ALLOWED_LEAGUE_IDS];

const SEASON = new Date().getFullYear();

async function fetchAPI(endpoint, key) {
  const res = await fetch(`https://v3.football.api-sports.io${endpoint}`, {
    headers: { 'x-apisports-key': key },
  });
  const data = await res.json();
  return data.response || [];
}

async function logCron(stats, status, errorMsg) {
  try {
    await query(
      `INSERT INTO cron_logs (job_name, fixtures_processed, players_upserted, status, error_msg)
       VALUES ($1,$2,$3,$4,$5)`,
      ['collect-daily', stats.standings, stats.teams, status, errorMsg || null]
    );
  } catch (_) {}
}

export default async function handler(req, res) {
  const key = process.env.API_FOOTBALL_KEY || process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY;

  if (!key) return res.status(500).json({ error: 'Environment vars lipsa' });

  const startTime = Date.now();
  const stats = { leagues: 0, teams: 0, standings: 0, errors: [] };

  try {
    for (const leagueId of PRIORITY_LEAGUES) {

      try {
        const standings = await fetchAPI(`/standings?league=${leagueId}&season=${SEASON}`, key);
        if (!standings.length) continue;

        const league = standings[0]?.league;
        if (league) {
          await query(
            `INSERT INTO leagues (league_id, name, country, logo, active, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (league_id) DO UPDATE SET
               name=EXCLUDED.name, country=EXCLUDED.country,
               logo=EXCLUDED.logo, active=EXCLUDED.active, updated_at=EXCLUDED.updated_at`,
            [league.id, league.name, league.country, league.logo || null, true, new Date().toISOString()]
          );
          stats.leagues++;
        }

        const rows = standings[0]?.league?.standings?.[0] || [];

        for (const row of rows) {
          await query(
            `INSERT INTO standings
               (league_id, season, team_id, team_name, rank, points,
                goals_for, goals_against, goal_diff, played, wins, draws, losses, form, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (league_id, season, team_id) DO UPDATE SET
               team_name=EXCLUDED.team_name, rank=EXCLUDED.rank, points=EXCLUDED.points,
               goals_for=EXCLUDED.goals_for, goals_against=EXCLUDED.goals_against,
               goal_diff=EXCLUDED.goal_diff, played=EXCLUDED.played,
               wins=EXCLUDED.wins, draws=EXCLUDED.draws, losses=EXCLUDED.losses,
               form=EXCLUDED.form, updated_at=EXCLUDED.updated_at`,
            [
              leagueId, SEASON, row.team.id, row.team.name, row.rank, row.points,
              row.all?.goals?.for     || 0,
              row.all?.goals?.against || 0,
              row.goalsDiff           || 0,
              row.all?.played         || 0,
              row.all?.win            || 0,
              row.all?.draw           || 0,
              row.all?.lose           || 0,
              row.form || null,
              new Date().toISOString(),
            ]
          );
          stats.standings++;

          await query(
            `INSERT INTO teams (team_id, name, logo, updated_at)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (team_id) DO UPDATE SET
               name=EXCLUDED.name, logo=EXCLUDED.logo, updated_at=EXCLUDED.updated_at`,
            [row.team.id, row.team.name, row.team.logo || null, new Date().toISOString()]
          );
          stats.teams++;
        }
      } catch (e) {
        stats.errors.push(`league ${leagueId}: ${e.message}`);
      }
    }

    await logCron(stats, 'success', stats.errors.length ? stats.errors.join('; ') : null);

    return res.status(200).json({
      success:     true,
      duration_ms: Date.now() - startTime,
      stats,
    });
  } catch (error) {
    await logCron(stats, 'error', error.message);
    return res.status(500).json({ error: error.message });
  }
}
