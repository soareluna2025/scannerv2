// Cron: GET /api/cron/collect-players-season
// Colecteaza statistici sezoniere per jucator pentru echipele cu meciuri in urmatoarele 30 zile
// Rulare: zilnic 01:30 — ~400-500 apeluri API/run

import { query } from '../db.js';
import { fetchApiFootball } from '../utils/fetch-api.js';
import { writeToCazarma } from '../utils/cazarma.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SEASON = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;

async function logCron(status, msg = '') {
  try {
    await query(`INSERT INTO cron_logs (job_name, status, error_msg) VALUES ('collect-players-season', $1, $2)`, [status, msg || null]);
  } catch (_) {}
}

export default async function handler(req, res) {
  try {
    const { rows: teams } = await query(
      `SELECT DISTINCT team_id FROM (
         SELECT home_team_id AS team_id FROM fixtures
         WHERE match_date >= NOW() AND match_date <= NOW() + INTERVAL '30 days'
         UNION
         SELECT away_team_id FROM fixtures
         WHERE match_date >= NOW() AND match_date <= NOW() + INTERVAL '30 days'
       ) t WHERE team_id IS NOT NULL
       LIMIT 300`
    );

    if (!teams.length) {
      await logCron('success', 'no teams');
      return res.status(200).json({ inserted: 0, teams: 0 });
    }

    let inserted = 0;

    for (const { team_id } of teams) {
      try {
        const r = await fetchApiFootball(`/players?team=${team_id}&season=${SEASON}&page=1`);
        const d = await r.json();
        await writeToCazarma('collect-players-season', `/players?team=${team_id}&season=${SEASON}&page=1`, team_id, d);

        for (const item of (d.response || [])) {
          const p = item.player;
          const s = item.statistics?.[0];
          if (!p?.id || !s?.league?.id) continue;

          await query(
            `INSERT INTO players_season
               (player_id, team_id, league_id, season, player_name, nationality, position, age,
                appearances, lineups, minutes, goals, assists, yellow_cards, red_cards, rating)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
             ON CONFLICT (player_id, league_id, season) DO UPDATE SET
               goals=EXCLUDED.goals, assists=EXCLUDED.assists,
               appearances=EXCLUDED.appearances, rating=EXCLUDED.rating,
               minutes=EXCLUDED.minutes, updated_at=NOW()`,
            [
              p.id, s.team?.id || team_id, s.league.id, SEASON,
              p.name || null, p.nationality || null,
              s.games?.position || null, p.age || null,
              s.games?.appearences || 0,
              s.games?.lineups || 0,
              s.games?.minutes || 0,
              s.goals?.total || 0,
              s.goals?.assists || 0,
              s.cards?.yellow || 0,
              s.cards?.red || 0,
              s.games?.rating ? parseFloat(s.games.rating) : null,
            ]
          );
          inserted++;
        }
      } catch (_) {}
      await sleep(300);
    }

    await logCron('success', `inserted:${inserted} teams:${teams.length}`);
    return res.status(200).json({ inserted, teams: teams.length });
  } catch (e) {
    await logCron('error', e.message);
    return res.status(500).json({ error: e.message });
  }
}
