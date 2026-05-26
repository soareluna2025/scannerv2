// Cron: GET /api/cron/collect-squads
// Colecteaza loturile echipelor cu meciuri in urmatoarele 30 zile
// Rulare: zilnic 02:00 — ~200 apeluri API/run

import { query } from '../db.js';
import { fetchApiFootball } from '../utils/fetch-api.js';
import { writeToCazarma } from '../utils/cazarma.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SEASON = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;

async function logCron(status, msg = '') {
  try {
    await query(`INSERT INTO cron_logs (job_name, status, error_msg) VALUES ('collect-squads', $1, $2)`, [status, msg || null]);
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
        const r = await fetchApiFootball(`/players/squads?team=${team_id}`);
        const d = await r.json();
        await writeToCazarma('collect-squads', `/players/squads?team=${team_id}`, team_id, d);

        for (const item of (d.response || [])) {
          for (const pl of (item.players || [])) {
            if (!pl.id) continue;
            await query(
              `INSERT INTO squads (team_id, season, player_id, player_name, number, position, age, photo)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (team_id, season, player_id) DO UPDATE SET
                 number=EXCLUDED.number, position=EXCLUDED.position,
                 age=EXCLUDED.age, updated_at=NOW()`,
              [
                team_id, SEASON,
                pl.id, pl.name || null,
                pl.number || null,
                pl.position || null,
                pl.age || null,
                pl.photo || null,
              ]
            );
            inserted++;
          }
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
