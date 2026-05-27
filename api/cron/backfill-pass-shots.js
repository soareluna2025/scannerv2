// GET /api/cron/backfill-pass-shots
// One-shot: populeaza pass_accuracy + shots_on_target pentru echipele din players_season
// care au aceste campuri NULL (dupa migratia add-players-season-pass-shots.sql).
// Sursa: players_season (nu fixtures) — prinde echipele fara meciuri viitoare.

import { query } from '../db.js';
import { fetchApiFootball } from '../utils/fetch-api.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SEASON = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;

export default async function handler(req, res) {
  try {
    const { rows: teams } = await query(
      `SELECT DISTINCT team_id FROM players_season
       WHERE season = $1 AND pass_accuracy IS NULL
       LIMIT 500`,
      [SEASON]
    );

    if (!teams.length) {
      return res.status(200).json({ ok: true, message: 'Nimic de actualizat', updated: 0, teams: 0 });
    }

    let updated = 0;

    for (const { team_id } of teams) {
      try {
        const r = await fetchApiFootball(`/players?team=${team_id}&season=${SEASON}&page=1`);
        const d = await r.json();

        for (const item of (d.response || [])) {
          const p = item.player;
          const s = item.statistics?.[0];
          if (!p?.id || !s) continue;

          const passAcc = s.passes?.accuracy != null ? parseFloat(s.passes.accuracy) : null;
          const sot     = s.shots?.on || 0;

          await query(
            `UPDATE players_season SET
               pass_accuracy   = $1,
               shots_on_target = $2,
               updated_at      = NOW()
             WHERE player_id = $3 AND season = $4 AND pass_accuracy IS NULL`,
            [passAcc, sot, p.id, SEASON]
          );
          updated++;
        }
      } catch (_) {}
      await sleep(300);
    }

    return res.status(200).json({ ok: true, updated, teams: teams.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
