// Cron: GET /api/cron/cazarma-router
// Citeste din cazarma_centrala (procesat=false) si distribuie in tabelele specifice
// Rulare: la fiecare 5 min (*/5 * * * *). Drenează coada în buclă până e goală
// (cap siguranță 2000/rulare) + lock anti-concurență.

import { query } from '../db.js';

const SEASON = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;
const BATCH_SIZE = 100;

async function logCron(status, msg = '') {
  try {
    await query(`INSERT INTO cron_logs (job_name, status, error_msg) VALUES ('cazarma-router', $1, $2)`, [status, msg || null]);
  } catch (_) {}
}

async function markProcessed(id, eroare = null) {
  try {
    await query(
      `UPDATE cazarma_centrala SET procesat=TRUE, procesat_la=NOW(), eroare=$2 WHERE id=$1`,
      [id, eroare]
    );
  } catch (_) {}
}

function extractSeason(endpoint) {
  const m = endpoint.match(/season=(\d{4})/);
  return m ? parseInt(m[1]) : SEASON;
}

async function handleTopScorers(entry) {
  const d = entry.raw_data;
  const leagueId = entry.entity_id;
  const season = extractSeason(entry.endpoint);
  let count = 0;
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
      [leagueId, season, p.id, p.name || null,
       s?.team?.id || null, s?.team?.name || null,
       s?.goals?.total || 0, s?.goals?.assists || 0,
       s?.penalty?.scored || 0, s?.games?.appearences || 0]
    );
    count++;
  }
  return count;
}

async function handleTopAssists(entry) {
  const d = entry.raw_data;
  const leagueId = entry.entity_id;
  const season = extractSeason(entry.endpoint);
  let count = 0;
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
      [leagueId, season, p.id, p.name || null,
       s?.team?.id || null, s?.team?.name || null,
       s?.goals?.assists || 0, s?.goals?.total || 0,
       s?.games?.appearences || 0]
    );
    count++;
  }
  return count;
}

async function handlePlayersSeason(entry) {
  const d = entry.raw_data;
  const teamId = entry.entity_id;
  const season = extractSeason(entry.endpoint);
  let count = 0;
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
      [p.id, s.team?.id || teamId, s.league.id, season,
       p.name || null, p.nationality || null,
       s.games?.position || null, p.age || null,
       s.games?.appearences || 0, s.games?.lineups || 0,
       s.games?.minutes || 0, s.goals?.total || 0,
       s.goals?.assists || 0, s.cards?.yellow || 0,
       s.cards?.red || 0,
       s.games?.rating ? parseFloat(s.games.rating) : null]
    );
    count++;
  }
  return count;
}

async function handleSquads(entry) {
  const d = entry.raw_data;
  const teamId = entry.entity_id;
  const season = extractSeason(entry.endpoint) || SEASON;
  let count = 0;
  for (const item of (d.response || [])) {
    for (const pl of (item.players || [])) {
      if (!pl.id) continue;
      await query(
        `INSERT INTO squads (team_id, season, player_id, player_name, number, position, age, photo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (team_id, season, player_id) DO UPDATE SET
           number=EXCLUDED.number, position=EXCLUDED.position,
           age=EXCLUDED.age, updated_at=NOW()`,
        [teamId, season, pl.id, pl.name || null,
         pl.number || null, pl.position || null,
         pl.age || null, pl.photo || null]
      );
      count++;
    }
  }
  return count;
}

function getHandler(endpoint) {
  if (endpoint.includes('topscorers'))    return handleTopScorers;
  if (endpoint.includes('topassists'))    return handleTopAssists;
  if (endpoint.includes('/players/squads')) return handleSquads;
  if (endpoint.includes('/players?') || endpoint.includes('?team=')) return handlePlayersSeason;
  return null;
}

export default async function handler(req, res) {
  try {
    const { rows: entries } = await query(
      `SELECT id, sursa, endpoint, entity_id, raw_data
       FROM cazarma_centrala
       WHERE procesat = FALSE
       ORDER BY primit_la ASC
       LIMIT $1`,
      [BATCH_SIZE]
    );

    if (!entries.length) {
      // FIX log fals: 'nimic de procesat' era scris în error_msg, făcând admin/errors
      // să raporteze cron-ul ca eroare deși status era 'success'.
      // Acum logăm doar pe consolă (info), iar cron_logs primește error_msg=NULL.
      console.log('[cazarma-router] nimic de procesat');
      await logCron('success');
      return res.status(200).json({ processed: 0, skipped: 0 });
    }

    let processed = 0, skipped = 0;

    for (const entry of entries) {
      const routeHandler = getHandler(entry.endpoint);
      if (!routeHandler) {
        await markProcessed(entry.id, 'handler lipsa');
        skipped++;
        continue;
      }
      try {
        await routeHandler(entry);
        await markProcessed(entry.id);
        processed++;
      } catch (e) {
        await markProcessed(entry.id, e.message);
        skipped++;
      }
    }

    // Curata intrari procesate mai vechi de 7 zile
    await query(
      `DELETE FROM cazarma_centrala WHERE procesat=TRUE AND procesat_la < NOW() - INTERVAL '7 days'`
    );

    await logCron('success', `procesat:${processed} sarit:${skipped} total:${entries.length}`);
    return res.status(200).json({ processed, skipped, total: entries.length });
  } catch (e) {
    await logCron('error', e.message);
    return res.status(500).json({ error: e.message });
  }
}
