// Cron: GET /api/cron/collect-national-history
// Colectează ultimele 20 meciuri FT pentru fiecare națională din CM 2026 (league=1)
// și le salvează în fixtures_history. Naționalele au 1-4 meciuri în istoric → insuficient
// pentru predicții; /fixtures?team={id}&last=20&status=FT umple golul.
// Lista de echipe e citită DIN DB la runtime (nu hardcodată) → mereu actuală.
// Rulare: luni 03:00 (săptămânal — naționalele joacă rar). ~48 calls/rulare.

import { query } from '../db.js';
import { fetchApiFootball } from '../utils/fetch-api.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const DONE = ['FT', 'AET', 'PEN'];

async function logCron(status, msg = '') {
  try {
    await Promise.resolve(/* cron_logs → dispecer */);
  } catch (_) {}
}

// Upsert un meci FT în fixtures_history (același format ca restul codebase-ului).
async function saveFixture(fx) {
  const fid = fx?.fixture?.id;
  const status = fx?.fixture?.status?.short;
  if (!fid || !DONE.includes(status)) return false;
  const hg = fx?.goals?.home;
  const ag = fx?.goals?.away;
  if (hg == null || ag == null) return false;   // fără scor → nu e istoric util
  await query(
    `INSERT INTO fixtures_history
       (fixture_id, match_date, league_id, season,
        home_team_id, home_team_name, away_team_id, away_team_name,
        home_goals, away_goals, home_ht, away_ht, status_short)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (fixture_id) DO UPDATE SET
       home_goals = EXCLUDED.home_goals,
       away_goals = EXCLUDED.away_goals,
       home_ht    = EXCLUDED.home_ht,
       away_ht    = EXCLUDED.away_ht,
       status_short = EXCLUDED.status_short`,
    [
      fid,
      fx?.fixture?.date || null,
      fx?.league?.id || null,
      fx?.league?.season || (fx?.fixture?.date ? new Date(fx.fixture.date).getFullYear() : null),
      fx?.teams?.home?.id || null, fx?.teams?.home?.name || null,
      fx?.teams?.away?.id || null, fx?.teams?.away?.name || null,
      hg, ag,
      fx?.score?.halftime?.home ?? null,
      fx?.score?.halftime?.away ?? null,
      status,
    ]
  );
  return true;
}

export default async function handler(req, res) {
  try {
    // Echipele CM 2026 (league=1) — citite DIN DB la runtime (mereu actuale).
    const { rows: teams } = await query(`
      SELECT DISTINCT team_id, name FROM (
        SELECT home_team_id AS team_id, home_team_name AS name
          FROM fixtures WHERE league_id = 1
        UNION
        SELECT away_team_id AS team_id, away_team_name AS name
          FROM fixtures WHERE league_id = 1
      ) t
      WHERE team_id IS NOT NULL
      ORDER BY name
    `);

    if (!teams.length) {
      await logCron('success', 'no WC teams in fixtures (league=1)');
      return res.status(200).json({ ok: true, teams_processed: 0, fixtures_upserted: 0, errors: [] });
    }

    let teamsProcessed = 0;
    let fixturesUpserted = 0;
    const errors = [];

    for (const t of teams) {
      try {
        const r = await fetchApiFootball(`/fixtures?team=${t.team_id}&last=20&status=FT`);
        const d = await r.json();
        const list = d.response || [];
        for (const fx of list) {
          try { if (await saveFixture(fx)) fixturesUpserted++; }
          catch (_) { /* skip fixture punctual */ }
        }
        teamsProcessed++;
      } catch (e) {
        errors.push(`team ${t.team_id} (${t.name || '?'}): ${e.message}`);
      }
      await sleep(200);   // rate-limit politicos între echipe
    }

    const errNote = errors.length ? errors.slice(0, 10).join(' | ') : null;
    await logCron(errors.length ? 'error' : 'success',
      `teams:${teamsProcessed}/${teams.length} upserted:${fixturesUpserted}${errNote ? ' | ' + errNote : ''}`);
    return res.status(200).json({
      ok: true,
      teams_processed: teamsProcessed,
      fixtures_upserted: fixturesUpserted,
      errors,
    });
  } catch (e) {
    await logCron('error', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
