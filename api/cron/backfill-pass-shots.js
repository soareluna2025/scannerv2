// GET /api/cron/backfill-pass-shots
// Colecteaza players_season pentru TOATE echipele din standings (sezon curent)
// care nu au inca date in players_season.
// Sursa: standings (2106 echipe whitelisted) — mult mai larg decat fixtures (30 zile).
// LIMIT 500/run — ruleaza de ~5 ori pana acopera toate echipele.

import { query } from '../db.js';
import { fetchApiFootball } from '../utils/fetch-api.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SEASON = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;

export default async function handler(req, res) {
  try {
    // Echipe din standings care nu au inca niciun rand in players_season pentru sezonul curent
    const { rows: teams } = await query(
      `SELECT DISTINCT s.team_id
       FROM standings s
       WHERE s.season = $1
         AND s.team_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM players_season ps
           WHERE ps.team_id = s.team_id AND ps.season = $1
         )
       LIMIT 500`,
      [SEASON]
    );

    if (!teams.length) {
      return res.status(200).json({ ok: true, message: 'Toate echipele din standings au date in players_season', inserted: 0, teams: 0 });
    }

    let inserted = 0;

    for (const { team_id } of teams) {
      try {
        const r = await fetchApiFootball(`/players?team=${team_id}&season=${SEASON}&page=1`);
        const d = await r.json();

        for (const item of (d.response || [])) {
          const p = item.player;
          const s = item.statistics?.[0];
          if (!p?.id || !s?.league?.id) continue;

          const passAcc = s.passes?.accuracy != null ? parseFloat(s.passes.accuracy) : null;
          const sot     = s.shots?.on || 0;

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
              passAcc,
              sot,
            ]
          );
          inserted++;
        }
      } catch (_) {}
      await sleep(300);
    }

    // Cate echipe mai raman dupa acest run
    const { rows: remaining } = await query(
      `SELECT COUNT(DISTINCT s.team_id) AS cnt
       FROM standings s
       WHERE s.season = $1
         AND s.team_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM players_season ps
           WHERE ps.team_id = s.team_id AND ps.season = $1
         )`,
      [SEASON]
    );

    return res.status(200).json({
      ok: true,
      inserted,
      teams: teams.length,
      remaining: Number(remaining[0]?.cnt || 0),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
