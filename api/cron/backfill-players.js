// Cron/admin: POST|GET /api/cron/backfill-players
// Populează players_season pentru TOATE echipele din ligile cu leagues.active=true,
// pe sezoanele 2025 ȘI 2026. Refolosește EXACT logica de colectare din
// collect-players-season.js (apel API-Football /players paginat + upsert).
//
// - Idempotent + reluabil: poziția salvată în app_settings (backfill_players_idx).
//   ON CONFLICT (player_id, league_id, season) DO UPDATE (cheia players_season).
// - no_data markers în app_settings când API nu întoarce nimic pt (team,season).
// - Rulează în fundal (fire-and-forget); endpoint-ul răspunde imediat cu starea.
// - Prioritate: ACOPERIRE completă, nu economie API. Doar rate-limit tehnic
//   gestionat de fetchApiFootball (retry 429) + sleep mic între apeluri.
//
// NU atinge scoring/funcții imutabile — doar POPULEAZĂ players_season, tabela pe
// care fallback-ul score7 (calcStrSeason) și pagina de echipă o folosesc deja.

import { query } from '../db.js';
import { fetchApiFootball } from '../utils/fetch-api.js';
import { writeToCazarma } from '../utils/cazarma.js';

const SEASONS = [2025, 2026];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// State în memorie (per proces) — evită rulări concurente.
let running = false;
let stopFlag = false;
const state = { running: false, season: null, teamIdx: 0, teamsTotal: 0,
                inserted: 0, teamsDone: 0, noData: 0, startedAt: null, lastTeam: null };

async function ensureSettings() {
  await query(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMP DEFAULT NOW())`).catch(() => {});
}
async function getSetting(key) {
  try { const r = await query('SELECT value FROM app_settings WHERE key=$1', [key]); return r.rows[0]?.value ?? null; }
  catch { return null; }
}
async function setSetting(key, value) {
  try {
    await query(`INSERT INTO app_settings (key, value) VALUES ($1,$2)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [key, String(value)]);
  } catch (_) {}
}
async function logCron(status, msg = '') {
  try { await query(`INSERT INTO cron_logs (job_name, status, error_msg) VALUES ('backfill-players', $1, $2)`, [status, msg || null]); }
  catch (_) {}
}

// Echipele tuturor ligilor active, pt un sezon: din standings (team_id, league_id, season)
// restrâns la ligile cu leagues.active=true. Standings e populat de collect-daily pe
// sezon dinamic per ligă → acoperă loturile complete, nu doar echipele cu meci imediat.
async function teamsForActiveLeagues(season) {
  try {
    const r = await query(
      `SELECT DISTINCT s.team_id, s.league_id
         FROM standings s
         JOIN leagues l ON l.league_id = s.league_id
        WHERE l.active = TRUE AND s.season = $1 AND s.team_id IS NOT NULL
        ORDER BY s.league_id, s.team_id`, [season]);
    return r.rows;
  } catch (_) { return []; }
}

// Colectare players_season pt o echipă+sezon (paginat) — logică identică cu
// collect-players-season.js. Întoarce nr. de rânduri upsert-ate (-1 = no_data).
async function collectTeamSeason(teamId, season) {
  let inserted = 0;
  let any = false;
  let page = 1;
  while (true) {
    const r = await fetchApiFootball(`/players?team=${teamId}&season=${season}&page=${page}`);
    const d = await r.json();
    const totalPages = d.paging?.total || 1;
    await writeToCazarma('backfill-players', `/players?team=${teamId}&season=${season}&page=${page}`, teamId, d).catch(() => {});

    for (const item of (d.response || [])) {
      const p = item.player;
      const s = item.statistics?.[0];
      if (!p?.id || !s?.league?.id) continue;
      any = true;
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
          p.id, s.team?.id || teamId, s.league.id, season,
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
    await sleep(250);
  }
  return any ? inserted : -1;
}

async function runLoop() {
  running = true; stopFlag = false;
  state.running = true; state.startedAt = new Date().toISOString();
  state.inserted = 0; state.teamsDone = 0; state.noData = 0;

  try {
    // Construiește lista (season, team) pe ambele sezoane.
    const work = [];
    for (const season of SEASONS) {
      const teams = await teamsForActiveLeagues(season);
      for (const t of teams) work.push({ season, teamId: t.team_id });
    }
    state.teamsTotal = work.length;

    // Resume: index salvat (continuă de unde a rămas).
    let startIdx = parseInt(await getSetting('backfill_players_idx') || '0', 10);
    if (isNaN(startIdx) || startIdx >= work.length) startIdx = 0;

    for (let i = startIdx; i < work.length; i++) {
      if (stopFlag) break;
      const { season, teamId } = work[i];
      state.season = season; state.teamIdx = i; state.lastTeam = teamId;

      // no_data marker: sări echipele deja marcate fără date (idempotent).
      const ndKey = `no_data:players:${teamId}:${season}`;
      const nd = await getSetting(ndKey);
      if (nd === '1') { state.teamsDone++; await setSetting('backfill_players_idx', String(i + 1)); continue; }

      try {
        const n = await collectTeamSeason(teamId, season);
        if (n === -1) { state.noData++; await setSetting(ndKey, '1'); }
        else { state.inserted += n; }
      } catch (e) {
        // eroare tranzitorie (rate-limit etc.) — NU marca no_data, reia data viitoare.
        console.error(`[backfill-players] team ${teamId} season ${season}: ${e.message}`);
      }
      state.teamsDone++;
      await setSetting('backfill_players_idx', String(i + 1));
      await sleep(250);

      // Log progres periodic în cron_logs (la fiecare 50 echipe).
      if (state.teamsDone % 50 === 0) {
        await logCron('success', `progres ${state.teamsDone}/${state.teamsTotal} inserted:${state.inserted} noData:${state.noData}`);
      }
    }

    // Terminat complet → resetează indexul pt o rulare viitoare curată.
    if (!stopFlag) await setSetting('backfill_players_idx', '0');
    await logCron('success', `DONE ${state.teamsDone}/${state.teamsTotal} inserted:${state.inserted} noData:${state.noData}${stopFlag ? ' (stopped)' : ''}`);
  } catch (e) {
    await logCron('error', e.message);
  } finally {
    running = false; state.running = false;
  }
}

export default async function handler(req, res) {
  await ensureSettings();
  const action = (req.query?.action || '').toLowerCase();

  if (action === 'status') {
    return res.status(200).json({ ok: true, ...state });
  }
  if (action === 'stop') {
    stopFlag = true;
    return res.status(200).json({ ok: true, stopping: true });
  }
  if (action === 'reset') {
    await setSetting('backfill_players_idx', '0');
    return res.status(200).json({ ok: true, reset: true });
  }

  // START (default)
  if (running) {
    return res.status(200).json({ ok: true, already_running: true, ...state });
  }
  // Pre-numără echipele pt feedback imediat (ETA).
  let teamsTotal = 0;
  for (const season of SEASONS) {
    const t = await teamsForActiveLeagues(season);
    teamsTotal += t.length;
  }
  runLoop().catch(e => { console.error('[backfill-players] fatal:', e.message); });
  return res.status(200).json({
    ok: true, started: true, seasons: SEASONS, teams_total: teamsTotal,
    note: 'Rulează în fundal. Verifică ?action=status pentru progres.',
  });
}
