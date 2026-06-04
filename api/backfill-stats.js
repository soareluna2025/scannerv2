// Admin endpoint: backfill h2h + match_stats pentru meciuri FT vechi.
//
// Cron-urile normale (scan.js, collect-finished.js) proceseaza doar
// meciurile recente. Acest endpoint proceseaza meciuri istorice care
// au scor in fixtures_history dar le lipseste h2h/match_stats.
//
// Apelare:
//   GET /api/backfill-stats?key=ADMIN_KEY&limit=200
//   GET /api/backfill-stats?key=ADMIN_KEY&type=h2h&limit=500
//   GET /api/backfill-stats?key=ADMIN_KEY&type=match_stats&limit=500

import { query } from './db.js';
import { fetchApiFootball } from './utils/fetch-api.js';

const log = (...m) => console.log('[backfill-stats]', ...m);

export async function backfillH2H(limit) {
  // Selectez meciuri FT din fixtures_history fara entry in h2h
  const { rows: missing } = await query(`
    SELECT fh.fixture_id, fh.league_id, fh.home_team_id, fh.away_team_id,
           fh.match_date, fh.home_goals, fh.away_goals, fh.season
    FROM fixtures_history fh
    WHERE fh.status_short = 'FT'
      AND fh.home_team_id IS NOT NULL AND fh.away_team_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM h2h h
        WHERE h.fixture_id = fh.fixture_id
      )
    ORDER BY fh.match_date DESC NULLS LAST
    LIMIT $1
  `, [limit]);

  log(`backfillH2H: ${missing.length} meciuri de procesat`);
  let ok = 0;
  for (const row of missing) {
    try {
      const hid = row.home_team_id, aid = row.away_team_id;
      await query(
        `INSERT INTO h2h
           (team1_id, team2_id, fixture_id, home_team_id, away_team_id,
            match_date, home_goals, away_goals, league_id, season)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (team1_id, team2_id, fixture_id) DO UPDATE SET
           home_goals=EXCLUDED.home_goals, away_goals=EXCLUDED.away_goals`,
        [
          Math.min(hid, aid), Math.max(hid, aid),
          row.fixture_id, hid, aid,
          row.match_date,
          row.home_goals || 0, row.away_goals || 0,
          row.league_id, row.season || new Date(row.match_date || Date.now()).getFullYear(),
        ]
      );
      ok++;
    } catch (e) {
      log(`h2h fixture ${row.fixture_id} err: ${e.message}`);
    }
  }
  return { total: missing.length, ok };
}

export async function backfillMatchStats(limit) {
  // Selectez TOATE meciurile FT fara match_stats (tot istoricul disponibil)
  const { rows: missing } = await query(`
    SELECT fh.fixture_id, fh.home_team_id, fh.away_team_id
    FROM fixtures_history fh
    WHERE fh.status_short IN ('FT','AET','PEN')
      AND fh.home_team_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM match_stats ms WHERE ms.fixture_id = fh.fixture_id)
    ORDER BY fh.match_date DESC
    LIMIT $1
  `, [limit]);

  log(`backfillMatchStats: ${missing.length} meciuri de procesat`);
  let ok = 0, skipped = 0;
  for (const row of missing) {
    try {
      const r = await fetchApiFootball(`/fixtures/statistics?fixture=${row.fixture_id}`);
      const data = await r.json();
      const teamStats = data.response || [];
      if (!teamStats.length) { skipped++; continue; }

      for (const teamStat of teamStats) {
        const s = {};
        for (const entry of teamStat.statistics) s[entry.type] = entry.value;
        await query(
          `INSERT INTO match_stats
             (fixture_id, team_id, team_name,
              shots_on_goal, shots_total, blocked_shots,
              shots_insidebox, shots_outsidebox,
              expected_goals, ball_possession,
              total_passes, passes_accurate, pass_percentage,
              fouls, yellow_cards, red_cards, corner_kicks, offsides, goalkeeper_saves)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           ON CONFLICT (fixture_id, team_id) DO UPDATE SET
             shots_on_goal=EXCLUDED.shots_on_goal,
             expected_goals=EXCLUDED.expected_goals,
             yellow_cards=EXCLUDED.yellow_cards,
             corner_kicks=EXCLUDED.corner_kicks`,
          [
            row.fixture_id, teamStat.team.id, teamStat.team.name,
            parseInt(s['Shots on Goal']) || 0,
            parseInt(s['Total Shots']) || 0,
            parseInt(s['Blocked Shots']) || 0,
            parseInt(s['Shots insidebox']) || 0,
            parseInt(s['Shots outsidebox']) || 0,
            parseFloat(s['expected_goals']) || null,
            parseFloat(s['Ball Possession']) || null,
            parseInt(s['Total passes']) || 0,
            parseInt(s['Passes accurate']) || 0,
            parseFloat(s['Passes %']) || null,
            parseInt(s['Fouls']) || 0,
            parseInt(s['Yellow Cards']) || 0,
            parseInt(s['Red Cards']) || 0,
            parseInt(s['Corner Kicks']) || 0,
            parseInt(s['Offsides']) || 0,
            parseInt(s['Goalkeeper Saves']) || 0,
          ]
        );
      }
      ok++;
    } catch (e) {
      log(`match_stats fixture ${row.fixture_id} err: ${e.message}`);
    }
  }
  return { total: missing.length, ok, skipped };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const ADMIN_KEY = process.env.ADMIN_API_KEY;
  const key = req.query?.key || new URL(req.url || '', 'http://localhost').searchParams.get('key');
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const type = (req.query?.type || 'all').toLowerCase();
  const limit = Math.min(parseInt(req.query?.limit || '100', 10), 1000);

  try {
    const out = {};
    if (type === 'h2h' || type === 'all') {
      out.h2h = await backfillH2H(limit);
    }
    if (type === 'match_stats' || type === 'all') {
      out.match_stats = await backfillMatchStats(limit);
    }
    return res.status(200).json({ ok: true, type, limit, ...out });
  } catch (e) {
    log(`ERROR: ${e.message}`);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
