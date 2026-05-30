// Cron: GET /api/cron/auto-predict
// Generează predicții automate pentru TOATE meciurile NS din next 36h
// Elimină dependența de interacțiunea umană — fiecare meci primește predicție
// Rulare: zilnic 00:30

import { query } from '../db.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function logCron(status, msg = '') {
  try {
    await query(
      `INSERT INTO cron_logs (job_name, status, error_msg) VALUES ('auto-predict', $1, $2)`,
      [status, msg || null]
    );
  } catch (_) {}
}

export default async function handler(req, res) {
  try {
    // Toate meciurile NS din next 36h fără predicție recentă (< 12h)
    const { rows: fixtures } = await query(`
      SELECT f.fixture_id, f.home_team_id, f.away_team_id,
             f.home_team_name, f.away_team_name,
             f.league_id, COALESCE(l.name, '') AS league_name,
             f.match_date, f.status_short
      FROM fixtures f
      LEFT JOIN leagues l ON l.league_id = f.league_id
      WHERE f.status_short = 'NS'
        AND f.match_date >= NOW()
        AND f.match_date <= NOW() + INTERVAL '36 hours'
        AND f.home_team_id IS NOT NULL
        AND f.away_team_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM predictions p
          WHERE p.fixture_id = f.fixture_id
            AND p.updated_at > NOW() - INTERVAL '12 hours'
        )
      ORDER BY f.match_date ASC
      LIMIT 500
    `);

    if (!fixtures.length) {
      await logCron('success', 'no NS fixtures without recent prediction');
      return res.status(200).json({ predicted: 0, skipped: 0, errors: 0, total: 0 });
    }

    const port = process.env.PORT || 3000;
    let predicted = 0;
    let errors = 0;

    for (const fx of fixtures) {
      try {
        const dt = fx.match_date instanceof Date
          ? fx.match_date.toISOString()
          : String(fx.match_date || '');

        const params = new URLSearchParams({
          h:            fx.home_team_id,
          a:            fx.away_team_id,
          fid:          fx.fixture_id,
          hn:           fx.home_team_name || '',
          an:           fx.away_team_name || '',
          lgid:         fx.league_id || '',
          lg:           fx.league_name || '',
          dt,
          status_short: 'NS',
        });

        const r = await fetch(
          `http://localhost:${port}/api/enrich?${params}`,
          { signal: AbortSignal.timeout(20000) }
        );

        if (r.ok) {
          predicted++;
        } else {
          errors++;
          // Loghează cauza reală (status + corp răspuns) — înainte eroarea era mută.
          let body = '';
          try { body = (await r.text()).slice(0, 300); } catch (_) {}
          console.error(`[auto-predict] fixture ${fx.fixture_id} HTTP ${r.status}: ${body}`);
        }
      } catch (e) {
        errors++;
        // Stack complet — înainte `catch(_){}` ascundea total eroarea (timeout/network/etc).
        console.error(`[auto-predict] fixture ${fx.fixture_id} exception:`, e && e.stack ? e.stack : e);
      }
      await sleep(300);
    }

    await logCron('success', `predicted:${predicted} errors:${errors} total:${fixtures.length}`);
    return res.status(200).json({ predicted, errors, total: fixtures.length });
  } catch (e) {
    await logCron('error', e.message);
    return res.status(500).json({ error: e.message });
  }
}
