// Cron: GET /api/cron/collect-top-scorers
// Colecteaza top marcatori + top pasatori per liga activa din standings
// Rulare: zilnic 01:00 — ~330 apeluri API/run

import { query } from '../db.js';
import { fetchApiFootball } from '../utils/fetch-api.js';
import { writeToCazarma } from '../utils/cazarma.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SEASON = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;

async function logCron(status, msg = '') {
  try {
    await query(`INSERT INTO cron_logs (job_name, status, error_msg) VALUES ('collect-top-scorers', $1, $2)`, [status, msg || null]);
  } catch (_) {}
}

export default async function handler(req, res) {
  try {
    const { rows: leagues } = await query(
      `SELECT DISTINCT league_id FROM standings WHERE season = $1 LIMIT 200`,
      [SEASON]
    );

    if (!leagues.length) {
      await logCron('success', 'no leagues');
      return res.status(200).json({ scorers: 0, assists: 0, leagues: 0 });
    }

    let scorers = 0, assists = 0;

    for (const { league_id } of leagues) {
      // Top scorers
      try {
        const r = await fetchApiFootball(`/players/topscorers?league=${league_id}&season=${SEASON}`);
        const d = await r.json();
        await writeToCazarma('collect-top-scorers', `/players/topscorers?league=${league_id}&season=${SEASON}`, league_id, d);
        for (const item of (d.response || [])) {
          const p = item.player;
          const s = item.statistics?.[0];
          if (!p?.id) continue;
          await query(
            `INSERT INTO top_scorers
               (league_id, season, player_id, player_name, team_id, team_name, goals, assists, penalties, appearances)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (league_id, season, player_id) DO UPDATE SET
               goals=EXCLUDED.goals, assists=EXCLUDED.assists,
               appearances=EXCLUDED.appearances, updated_at=NOW()`,
            [
              league_id, SEASON, p.id, p.name || null,
              s?.team?.id || null, s?.team?.name || null,
              s?.goals?.total || 0,
              s?.goals?.assists || 0,
              s?.penalty?.scored || 0,
              s?.games?.appearences || 0,
            ]
          );
          scorers++;
        }
      } catch (_) {}
      await sleep(300);

      // Top assists
      try {
        const r = await fetchApiFootball(`/players/topassists?league=${league_id}&season=${SEASON}`);
        const d = await r.json();
        await writeToCazarma('collect-top-scorers', `/players/topassists?league=${league_id}&season=${SEASON}`, league_id, d);
        for (const item of (d.response || [])) {
          const p = item.player;
          const s = item.statistics?.[0];
          if (!p?.id) continue;
          await query(
            `INSERT INTO top_assists
               (league_id, season, player_id, player_name, team_id, team_name, assists, goals, appearances)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (league_id, season, player_id) DO UPDATE SET
               assists=EXCLUDED.assists, goals=EXCLUDED.goals,
               appearances=EXCLUDED.appearances, updated_at=NOW()`,
            [
              league_id, SEASON, p.id, p.name || null,
              s?.team?.id || null, s?.team?.name || null,
              s?.goals?.assists || 0,
              s?.goals?.total || 0,
              s?.games?.appearences || 0,
            ]
          );
          assists++;
        }
      } catch (_) {}
      await sleep(300);
    }

    await logCron('success', `scorers:${scorers} assists:${assists} leagues:${leagues.length}`);
    return res.status(200).json({ scorers, assists, leagues: leagues.length });
  } catch (e) {
    await logCron('error', e.message);
    return res.status(500).json({ error: e.message });
  }
}
