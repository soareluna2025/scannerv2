// api/backfill.js — Season-first backfill (2026→2022)
// Per-fixture: statistics + events + players
// Persistent state in app_settings (resume after VPS restart)

import { query } from './db.js';
import { ALLOWED_LEAGUE_IDS } from './leagues.js';
import { calcPlayerScore } from './calc-utils.js';
import { fetchApiFootball } from './utils/fetch-api.js';
import { isAllowedLeague } from './utils/league-filter.js';

const SEASONS    = [2026, 2025, 2024, 2023, 2022];
const LEAGUE_IDS = [...ALLOWED_LEAGUE_IDS];
const BASE_URL   = 'https://v3.football.api-sports.io';
const DELAY_MS   = 250;
const STOP_AT    = 100_000; // reserve 50k/day for live scanner

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg)  { console.log(`[backfill] ${new Date().toISOString()} ${msg}`); }
function apiKey()  {
  return process.env.API_FOOTBALL_KEY
      || process.env.FOOTBALL_API_KEY
      || process.env.APIFOOTBALL_KEY;
}

// ── In-memory state ───────────────────────────────────────────────────────────

let running           = false;
let stopFlag          = false;
let apiUsedToday      = 0;
let apiDateTracked    = '';
let currentSeasonIdx  = 0;
let currentLeagueIdx  = 0;
let currentFixtureIdx = 0;
let currentLeagueId   = null;
let currentSeason     = null;
let totalFixtures     = 0;

// ── App Settings ──────────────────────────────────────────────────────────────

async function initAppSettings() {
  await query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`ALTER TABLE backfill_progress ADD COLUMN IF NOT EXISTS current_season INTEGER`);
  await query(`ALTER TABLE backfill_progress ADD COLUMN IF NOT EXISTS current_fixture_index INTEGER DEFAULT 0`);
  await query(`ALTER TABLE backfill_progress ADD COLUMN IF NOT EXISTS total_fixtures INTEGER DEFAULT 0`);
}

async function getSetting(key) {
  try {
    const r = await query('SELECT value FROM app_settings WHERE key=$1', [key]);
    return r.rows[0]?.value ?? null;
  } catch { return null; }
}

async function setSetting(key, value) {
  try {
    await query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [key, String(value)]
    );
  } catch (e) { log(`setSetting ${key} error: ${e.message}`); }
}

async function savePosition(si, li, fi) {
  await setSetting('backfill_season_idx',  String(si));
  await setSetting('backfill_league_idx',  String(li));
  await setSetting('backfill_fixture_idx', String(fi));
}

// ── M3: Real API usage from /status endpoint ────────────────────────────────
let _lastRealUsageCheck = 0;
async function getRealApiUsage() {
  try {
    const res  = await fetchApiFootball('/status');
    const d    = await res.json();
    const used  = d.response?.requests?.current || 0;
    const limit = d.response?.requests?.limit_day || 150_000;
    await setSetting('backfill_api_used',  String(used));
    await setSetting('backfill_api_limit', String(limit));
    apiUsedToday = used;
    log(`getRealApiUsage: used=${used} limit=${limit}`);
    return { used, limit };
  } catch (e) {
    log(`getRealApiUsage error: ${e.message}`);
    return null;
  }
}

// ── M9: Exponential backoff fetch ───────────────────────────────────────────
async function fetchWithBackoff(endpoint, maxRetries = 4) {
  if (!apiKey()) throw new Error('API_FOOTBALL_KEY missing');
  await sleep(DELAY_MS);

  // Refresh daily counter
  const today = new Date().toISOString().slice(0, 10);
  if (apiDateTracked !== today) {
    const savedDate = await getSetting('backfill_api_date');
    if (savedDate === today) {
      apiUsedToday = parseInt(await getSetting('backfill_api_used') || '0');
    } else {
      apiUsedToday = 0;
      await setSetting('backfill_api_date', today);
      await setSetting('backfill_api_used', '0');
    }
    apiDateTracked = today;
  }

  // M3: Check real usage from API every 10 minutes
  if (Date.now() - _lastRealUsageCheck > 10 * 60_000) {
    _lastRealUsageCheck = Date.now();
    await getRealApiUsage();
  }

  for (let i = 0; i < maxRetries; i++) {
    const res = await fetchApiFootball(endpoint);
    apiUsedToday++;

    if (apiUsedToday % 20 === 0) {
      await setSetting('backfill_api_used', String(apiUsedToday));
    }
    if (apiUsedToday >= STOP_AT) {
      stopFlag = true;
      log(`Daily limit ${STOP_AT} reached — auto-stopping`);
    }

    return res;
  }
  return null;
}

async function apiFetch(endpoint) {
  const res = await fetchWithBackoff(endpoint);
  if (!res) return { response: [] };
  return res.json();
}

// ── Collect functions ─────────────────────────────────────────────────────────

async function collectStats(fixtureId) {
  const data  = await apiFetch(`/fixtures/statistics?fixture=${fixtureId}`);
  const teams = data.response || [];
  for (const t of teams) {
    const s = {};
    for (const e of t.statistics) s[e.type] = e.value;
    await query(
      `INSERT INTO match_stats
         (fixture_id, team_id, team_name,
          shots_on_goal, shots_total, blocked_shots,
          shots_insidebox, shots_outsidebox,
          expected_goals, ball_possession,
          total_passes, passes_accurate, pass_percentage,
          fouls, yellow_cards, red_cards, corner_kicks, offsides, goalkeeper_saves)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (fixture_id, team_id) DO NOTHING`,
      [
        fixtureId, t.team.id, t.team.name,
        parseInt(s['Shots on Goal'])     || 0,
        parseInt(s['Total Shots'])       || 0,
        parseInt(s['Blocked Shots'])     || 0,
        parseInt(s['Shots insidebox'])   || 0,
        parseInt(s['Shots outsidebox'])  || 0,
        parseFloat(s['expected_goals'])  || null,
        parseFloat(s['Ball Possession']) || null,
        parseInt(s['Total passes'])      || 0,
        parseInt(s['Passes accurate'])   || 0,
        parseFloat(s['Passes %'])        || null,
        parseInt(s['Fouls'])             || 0,
        parseInt(s['Yellow Cards'])      || 0,
        parseInt(s['Red Cards'])         || 0,
        parseInt(s['Corner Kicks'])      || 0,
        parseInt(s['Offsides'])          || 0,
        parseInt(s['Goalkeeper Saves'])  || 0,
      ]
    );
  }
}

async function collectEvents(fixtureId) {
  const data   = await apiFetch(`/fixtures/events?fixture=${fixtureId}`);
  const events = data.response || [];
  if (!events.length) return;
  await query('DELETE FROM match_events WHERE fixture_id=$1', [fixtureId]);
  for (const ev of events) {
    await query(
      `INSERT INTO match_events
         (fixture_id, elapsed, elapsed_extra, team_id, player_id, player_name,
          assist_id, assist_name, type, detail, comments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        fixtureId,
        ev.time?.elapsed    || 0,
        ev.time?.extra      || null,
        ev.team?.id         || null,
        ev.player?.id       || null,
        ev.player?.name     || null,
        ev.assist?.id       || null,
        ev.assist?.name     || null,
        ev.type,
        ev.detail,
        ev.comments         || null,
      ]
    );
  }
}

async function collectPlayers(fixtureId) {
  const data  = await apiFetch(`/fixtures/players?fixture=${fixtureId}`);
  const teams = data.response || [];
  for (const team of teams) {
    for (const p of team.players || []) {
      const pl   = p.player    || {};
      const stat = (p.statistics || [])[0] || {};
      if (!pl.id) continue;
      const rating   = stat.games?.rating ? parseFloat(stat.games.rating) : null;
      const goals    = stat.goals?.total   || 0;
      const assists  = stat.goals?.assists  || 0;
      const passAcc  = stat.passes?.accuracy != null ? parseFloat(stat.passes.accuracy) : null;
      const sot      = stat.shots?.on       || 0;
      await query(
        `INSERT INTO player_stats
           (player_id, fixture_id, team_id, team_name, player_name, position, rating,
            goals, assists, pass_accuracy, shots_on_target, minutes_played,
            yellow_cards, red_cards, dribbles_success, player_score)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (player_id, fixture_id) DO NOTHING`,
        [
          pl.id, fixtureId, team.team?.id, team.team?.name || '',
          pl.name || '', stat.games?.position || null,
          rating, goals, assists, passAcc, sot,
          stat.games?.minutes || 0,
          stat.cards?.yellow || 0, stat.cards?.red || 0,
          stat.dribbles?.success || 0,
          calcPlayerScore(rating, goals, assists, passAcc, sot),
        ]
      );
    }
  }
}

// ── Core: process one league+season ──────────────────────────────────────────

async function processLeagueSeason(leagueId, season, si, li, startFi) {
  const data     = await apiFetch(`/fixtures?league=${leagueId}&season=${season}&status=FT`);
  const fixtures = data.response || [];

  // Validare nume ligă din API — skip dacă WOMEN_TERMS/YOUTH_TERMS/LOWER_DIV_TERMS
  if (fixtures.length > 0) {
    const leagueName = fixtures[0]?.league?.name;
    if (!isAllowedLeague(leagueName, leagueId, ALLOWED_LEAGUE_IDS)) {
      log(`SKIP: ligă neautorizată ${leagueId} ${leagueName || '(fără nume)'}`);
      return;
    }
  }

  totalFixtures  = fixtures.length;

  log(`Season ${season} league ${leagueId}: ${fixtures.length} FT fixtures (from idx ${startFi})`);

  await query(
    `UPDATE backfill_progress
     SET status='in_progress', current_season=$1, current_fixture_index=$2, total_fixtures=$3, last_run=NOW()
     WHERE league_id=$4`,
    [season, startFi, fixtures.length, leagueId]
  ).catch(() => {});

  for (let fi = startFi; fi < fixtures.length; fi++) {
    if (stopFlag) {
      await savePosition(si, li, fi);
      await query(
        `UPDATE backfill_progress SET current_fixture_index=$1 WHERE league_id=$2`,
        [fi, leagueId]
      ).catch(() => {});
      return;
    }

    const fid = fixtures[fi]?.fixture?.id;
    if (!fid) continue;

    currentFixtureIdx = fi;

    // Skip already-collected fixtures
    const [hasStats, hasEvents, hasPlayers] = await Promise.all([
      query('SELECT 1 FROM match_stats    WHERE fixture_id=$1 LIMIT 1', [fid]).then(r => r.rows.length > 0),
      query('SELECT 1 FROM match_events   WHERE fixture_id=$1 LIMIT 1', [fid]).then(r => r.rows.length > 0),
      query('SELECT 1 FROM player_stats   WHERE fixture_id=$1 LIMIT 1', [fid]).then(r => r.rows.length > 0),
    ]);

    if (!hasStats)   { try { await collectStats(fid);   } catch (e) { log(`stats   ${fid}: ${e.message}`); } }
    if (!hasEvents)  { try { await collectEvents(fid);  } catch (e) { log(`events  ${fid}: ${e.message}`); } }
    if (!hasPlayers) { try { await collectPlayers(fid); } catch (e) { log(`players ${fid}: ${e.message}`); } }

    if (fi % 50 === 0) await savePosition(si, li, fi);
  }

  // League+season done — reset fixture index
  await savePosition(si, li + 1, 0);
  await query(
    `UPDATE backfill_progress
     SET current_fixture_index=$1, total_fixtures=$2 WHERE league_id=$3`,
    [fixtures.length, fixtures.length, leagueId]
  ).catch(() => {});
}

// ── Core: main loop ───────────────────────────────────────────────────────────

async function runBackfillLoop(startSi, startLi, startFi) {
  try {
    log(`Loop start: season[${startSi}]=${SEASONS[startSi]}, league[${startLi}], fixture[${startFi}]`);

    for (let si = startSi; si < SEASONS.length; si++) {
      const season  = SEASONS[si];
      const firstLi = (si === startSi) ? startLi : 0;

      for (let li = firstLi; li < LEAGUE_IDS.length; li++) {
        if (stopFlag) {
          await savePosition(si, li, 0);
          log(`Stopped at season ${season}, league ${LEAGUE_IDS[li]}`);
          return;
        }

        const leagueId       = LEAGUE_IDS[li];
        currentSeasonIdx  = si;
        currentLeagueIdx  = li;
        currentLeagueId   = leagueId;
        currentSeason     = season;
        currentFixtureIdx = (si === startSi && li === startLi) ? startFi : 0;

        if (li % 10 === 0) await savePosition(si, li, currentFixtureIdx);

        try {
          await processLeagueSeason(
            leagueId, season, si, li,
            (si === startSi && li === startLi) ? startFi : 0
          );
        } catch (e) {
          log(`Error season ${season} league ${leagueId}: ${e.message}`);
        }

        if (stopFlag) { await savePosition(si, li + 1, 0); return; }
      }
    }

    log('Backfill complete!');
    await savePosition(0, 0, 0);
  } finally {
    running  = false;
    stopFlag = false;
    await setSetting('backfill_running', 'false');
    await setSetting('backfill_api_used', String(apiUsedToday));
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

export async function initBackfillProgress() {
  try {
    await initAppSettings();

    // Remove rows for leagues no longer in the whitelist (keeps progress for valid leagues)
    const { rowCount } = await query(
      `DELETE FROM backfill_progress
       WHERE league_id != ALL($1::int[])`,
      [LEAGUE_IDS]
    );
    if (rowCount > 0) log(`Removed ${rowCount} stale leagues from backfill_progress`);

    // Insert missing whitelist leagues
    for (const leagueId of LEAGUE_IDS) {
      await query(
        `INSERT INTO backfill_progress (league_id, status, fixtures_processed, players_upserted)
         VALUES ($1,'pending',0,0)
         ON CONFLICT (league_id) DO NOTHING`,
        [leagueId]
      );
    }
    log(`Initialized: ${LEAGUE_IDS.length} leagues in backfill_progress`);
  } catch (e) {
    log(`initBackfillProgress error: ${e.message}`);
  }
}

export async function startBackfill() {
  if (running) return { error: 'already running' };

  // Load / reset daily API counter
  const today = new Date().toISOString().slice(0, 10);
  const savedDate = await getSetting('backfill_api_date');
  if (savedDate === today) {
    apiUsedToday = parseInt(await getSetting('backfill_api_used') || '0');
  } else {
    apiUsedToday = 0;
    await setSetting('backfill_api_date', today);
    await setSetting('backfill_api_used', '0');
  }
  apiDateTracked = today;

  // Load resume position
  const si = Math.min(parseInt(await getSetting('backfill_season_idx')  || '0'), SEASONS.length - 1);
  const li = Math.min(parseInt(await getSetting('backfill_league_idx')  || '0'), LEAGUE_IDS.length - 1);
  const fi = parseInt(await getSetting('backfill_fixture_idx') || '0');

  running           = true;
  stopFlag          = false;
  currentSeasonIdx  = si;
  currentLeagueIdx  = li;
  currentFixtureIdx = fi;
  currentSeason     = SEASONS[si]    || SEASONS[0];
  currentLeagueId   = LEAGUE_IDS[li] || LEAGUE_IDS[0];

  await setSetting('backfill_running', 'true');
  log(`Started — resuming from season[${si}]=${currentSeason}, league[${li}]=${currentLeagueId}, fixture[${fi}]`);

  runBackfillLoop(si, li, fi).catch(e => {
    log(`Fatal: ${e.message}`);
    running = false;
    setSetting('backfill_running', 'false').catch(() => {});
  });

  return {
    started: true,
    resumedFrom: { season: currentSeason, leagueId: currentLeagueId, fixtureIndex: fi },
  };
}

export async function stopBackfill() {
  if (!running) return { stopped: false, message: 'not running' };
  stopFlag = true;
  await setSetting('backfill_running', 'false');
  log(`Stop requested — season ${currentSeason}, league ${currentLeagueId}`);
  return {
    stopped:    true,
    lastSeason: currentSeason,
    lastLeague: currentLeagueId,
  };
}

export async function getBackfillStatus() {
  const today     = new Date().toISOString().slice(0, 10);
  const savedDate = await getSetting('backfill_api_date');
  const usedToday = (savedDate === today)
    ? parseInt(await getSetting('backfill_api_used') || '0')
    : 0;

  // Use in-memory state when running, otherwise read last saved position from DB
  let si = currentSeasonIdx, li = currentLeagueIdx, fi = currentFixtureIdx;
  let lid = currentLeagueId, season = currentSeason;
  if (!running) {
    si     = Math.min(parseInt(await getSetting('backfill_season_idx')  || '0'), SEASONS.length - 1);
    li     = Math.min(parseInt(await getSetting('backfill_league_idx')  || '0'), LEAGUE_IDS.length - 1);
    fi     = parseInt(await getSetting('backfill_fixture_idx') || '0');
    lid    = LEAGUE_IDS[li] || null;
    season = SEASONS[si]    || null;
  }

  let leagueName = null;
  if (lid) {
    try {
      const r = await query('SELECT name FROM leagues WHERE league_id=$1', [lid]);
      leagueName = r.rows[0]?.name || null;
    } catch {}
  }

  const totalPairs     = SEASONS.length * LEAGUE_IDS.length;
  const completedPairs = si * LEAGUE_IDS.length + li;
  const progressPct    = totalPairs > 0
    ? Math.round(completedPairs / totalPairs * 1000) / 10
    : 0;

  // Rough estimate: ~10 req per league (1 fixtures + avg 3 fixtures × 3 calls)
  const remainingPairs = Math.max(0, totalPairs - completedPairs);
  const estimatedMs    = remainingPairs * 10 * DELAY_MS;

  return {
    running,
    currentLeague:       lid ? { id: lid, name: leagueName } : null,
    currentSeason:       season,
    currentFixtureIndex: fi,
    totalFixtures,
    totalLeagues:        totalPairs,
    completedLeagues:    completedPairs,
    progressPct,
    apiUsedToday:        usedToday,
    apiRemainingToday:   Math.max(0, parseInt(await getSetting('backfill_api_limit') || '150000') - usedToday),
    estimatedTimeRemaining: formatDuration(estimatedMs),
  };
}

export async function resumeOnStartup() {
  try {
    const wasRunning = await getSetting('backfill_running');
    if (wasRunning === 'true') {
      log('Auto-resuming backfill after restart');
      await startBackfill();
    }
  } catch (e) {
    log(`resumeOnStartup error: ${e.message}`);
  }
}

// Kept for legacy callers — no-op in the new design
export async function runDailyBackfill() {
  log('runDailyBackfill called — use startBackfill() instead');
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '—';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return '<1m';
}
