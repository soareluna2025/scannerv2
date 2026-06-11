// Cron: GET /api/cron/collect-players-season
// Colecteaza statistici sezoniere per jucator pentru echipele cu meciuri in urmatoarele 30 zile
// Fetch TOATE paginile per echipa (paginare dinamica) — coverage 100% din squad.
// Rulare: zilnic 01:30

import { query } from '../db.js';
import { fetchApiFootball } from '../utils/fetch-api.js';
import { writeToCazarma } from '../utils/cazarma.js';
import { seasonForTeam } from '../utils/season.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function logCron(status, msg = '') {
  try {
    await Promise.resolve(/* cron_logs → dispecer */);
  } catch (_) {}
}

export default async function handler(req, res) {
  try {
    // Descoperire ECHIPE: meciuri în 30 zile (fixtures) + TOATE echipele din
    // standings (acum populat pe sezon dinamic per ligă). Astfel acoperim
    // loturile complete ale ligilor calendaristice (nu doar cele 8 cu meci imediat).
    const { rows: teams } = await query(
      `SELECT DISTINCT team_id FROM (
         SELECT home_team_id AS team_id FROM fixtures
         WHERE match_date >= NOW() AND match_date <= NOW() + INTERVAL '30 days'
         UNION
         SELECT away_team_id FROM fixtures
         WHERE match_date >= NOW() AND match_date <= NOW() + INTERVAL '30 days'
         UNION
         SELECT team_id FROM standings
       ) t WHERE team_id IS NOT NULL
       LIMIT 600`
    );

    if (!teams.length) {
      await logCron('success', 'no teams');
      return res.status(200).json({ inserted: 0, teams: 0 });
    }

    let inserted = 0;

    for (const { team_id } of teams) {
      try {
        // Sezon DINAMIC per echipă (liga ei → seasons.current), nu formula globală.
        const SEASON = await seasonForTeam(team_id);
        let page = 1;

        while (true) {
          const r = await fetchApiFootball(`/players?team=${team_id}&season=${SEASON}&page=${page}`);
          const d = await r.json();
          const totalPages = d.paging?.total || 1;

          await writeToCazarma('collect-players-season', `/players?team=${team_id}&season=${SEASON}&page=${page}`, team_id, d);

          for (const item of (d.response || [])) {
            const p = item.player;
            const s = item.statistics?.[0];
            if (!p?.id || !s?.league?.id) continue;

            await query(
              `INSERT INTO players_season
                 (player_id, team_id, league_id, season, player_name, nationality, position, age,
                  appearances, lineups, minutes, goals, assists, yellow_cards, red_cards, rating,
                  pass_accuracy, shots_on_target)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
               ON CONFLICT (player_id, league_id, season) DO UPDATE SET
                 goals=EXCLUDED.goals, assists=EXCLUDED.assists,
                 appearances=EXCLUDED.appearances, rating=EXCLUDED.rating,
                 minutes=EXCLUDED.minutes,
                 pass_accuracy=EXCLUDED.pass_accuracy,
                 shots_on_target=EXCLUDED.shots_on_target,
                 updated_at=NOW()`,
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
                s.passes?.accuracy != null ? parseFloat(s.passes.accuracy) : null,
                s.shots?.on || 0,
              ]
            );
            inserted++;
          }

          if (page >= totalPages || !(d.response?.length)) break;
          page++;
          await sleep(300);
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
