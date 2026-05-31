// api/backfill.js — Season-first backfill (2026→2022)
// Per-fixture: statistics + events + players
// Persistent state in app_settings (resume after VPS restart)

import { query } from './db.js';
import { ALLOWED_LEAGUE_IDS } from './leagues.js';
import { calcPlayerScore } from './calc-utils.js';
import { fetchApiFootball } from './utils/fetch-api.js';
import { isAllowedLeague } from './utils/league-filter.js';

const SEASONS    = [2025, 2026];
const LEAGUE_IDS = [...ALLOWED_LEAGUE_IDS];
const BASE_URL   = 'https://v3.football.api-sports.io';
const DELAY_MS   = 60;              // FIX3: redus — concurența limitează rata, nu sleep-ul
const CONCURRENCY_FULL  = 10;       // max fixture-uri/batch în mod normal
const CONCURRENCY_SAFE  = 5;        // redus când stabilizarea rulează (evită epuizare pool)
const API_PLAN_LIMIT = 300_000;    // FIX2: doar pentru afișare; NU mai oprește backfill-ul

// Concurență dinamică: dacă stabilizarea rulează → 5, altfel 10.
function currentConcurrency() {
  return globalThis._stabilizeActive ? CONCURRENCY_SAFE : CONCURRENCY_FULL;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg)  { console.log(`[backfill] ${new Date().toISOString()} ${msg}`); }
function apiKey()  {
  return process.env.API_FOOTBALL_KEY
      || process.env.FOOTBALL_API_KEY
      || process.env.APIFOOTBALL_KEY;
}

// Semaphor DB separat: max 8 conexiuni DB concurente din backfill (independent de
// semaphorul API). Previne epuizarea pool-ului (max 25) când backfill+stabilizare
// + scanner live rulează simultan.
let _dbActive = 0;
const _dbQueue = [];
const DB_MAX = 8;
function dbAcquire() {
  return new Promise(resolve => {
    if (_dbActive < DB_MAX) { _dbActive++; resolve(); }
    else _dbQueue.push(resolve);
  });
}
function dbRelease() {
  _dbActive--;
  const next = _dbQueue.shift();
  if (next) { _dbActive++; next(); }
}
// Wrapper: orice query DB din backfill trece prin semaphor.
async function dbQuery(text, params) {
  await dbAcquire();
  try { return await query(text, params); }
  finally { dbRelease(); }
}

// FIX3 — Semaphor simplu: max apeluri API concurente (egal cu concurența curentă).
let _semActive = 0;
const _semQueue = [];
function _semAcquire() {
  return new Promise(resolve => {
    if (_semActive < CONCURRENCY_FULL) { _semActive++; resolve(); }
    else _semQueue.push(resolve);
  });
}
function _semRelease() {
  _semActive--;
  const next = _semQueue.shift();
  if (next) { _semActive++; next(); }
}

// ── In-memory state ──────────────────────────────────────────────────────────────────────────────

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
let totalProcessed    = 0;   // FIX1: contor cumulativ fixture-uri procesate (sesiune)
let _startTs          = 0;   // FIX6: pentru viteză (fixture/min)

// ── App Settings ─────────────────────────────────────────────────────────────────────────────

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

// ── M3: Real API usage from /status endpoint ────────────────────────────────────────────
let _lastRealUsageCheck = 0;
async function getRealApiUsage() {
  try {
    const res  = await fetchApiFootball('/status');
    const d    = await res.json();
    const used  = d.response?.requests?.current || 0;
    const limit = d.response?.requests?.limit_day || API_PLAN_LIMIT;
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

// ── M9: Exponential backoff fetch ───────────────────────────────────────────────────
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

  // FIX3: limitează concurența apelurilor API prin semaphor.
  await _semAcquire();
  try {
    for (let i = 0; i < maxRetries; i++) {
      const res = await fetchApiFootball(endpoint);
      apiUsedToday++;

      if (apiUsedToday % 20 === 0) {
        await setSetting('backfill_api_used', String(apiUsedToday));
      }
      // FIX2: STOP_AT eliminat — backfill-ul se oprește DOAR la comanda STOP
      // sau la finalizarea naturală a tuturor fixture-urilor.
      return res;
    }
    return null;
  } finally {
    _semRelease();
  }
}

async function apiFetch(endpoint) {
  const res = await fetchWithBackoff(endpoint);
  if (!res) return { response: [] };
  return res.json();
}

// ── Collect functions ──────────────────────────────────────────────────────────────────

async function collectStats(fixtureId) {
  const data  = await apiFetch(`/fixtures/statistics?fixture=${fixtureId}`);
  const teams = data.response || [];
  if (!teams.length) {
    // FIX 2: marker no-data → evită retry infinit
    await setSetting(`no_data:stats:${fixtureId}`, String(Date.now()));
    return;
  }
  for (const t of teams) {
    const s = {};
    for (const e of t.statistics) s[e.type] = e.value;
    await dbQuery(
      `INSERT INTO match_stats
         (fixture_id, team_id, team_name,
          shots_on_goal, shots_total, blocked_shots,
          shots_insidebox, shots_outsidebox,
          expected_goals, ball_possession,
          total_passes, passes_accurate, pass_percentage,
          fouls, yellow_cards, red_cards, corner_kicks, offsides, goalkeeper_saves)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (fixture_id, team_id) DO UPDATE SET
         team_name=EXCLUDED.team_name,
         shots_on_goal=EXCLUDED.shots_on_goal,
         shots_total=EXCLUDED.shots_total,
         blocked_shots=EXCLUDED.blocked_shots,
         shots_insidebox=EXCLUDED.shots_insidebox,
         shots_outsidebox=EXCLUDED.shots_outsidebox,
         expected_goals=EXCLUDED.expected_goals,
         ball_possession=EXCLUDED.ball_possession,
         total_passes=EXCLUDED.total_passes,
         passes_accurate=EXCLUDED.passes_accurate,
         pass_percentage=EXCLUDED.pass_percentage,
         fouls=EXCLUDED.fouls,
         yellow_cards=EXCLUDED.yellow_cards,
         red_cards=EXCLUDED.red_cards,
         corner_kicks=EXCLUDED.corner_kicks,
         offsides=EXCLUDED.offsides,
         goalkeeper_saves=EXCLUDED.goalkeeper_saves`,
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
  if (!events.length) {
    await setSetting(`no_data:events:${fixtureId}`, String(Date.now()));
    return;
  }
  await dbQuery('DELETE FROM match_events WHERE fixture_id=$1', [fixtureId]);
  for (const ev of events) {
    await dbQuery(
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
  if (!teams.length) {
    await setSetting(`no_data:players:${fixtureId}`, String(Date.now()));
    return;
  }
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
      await dbQuery(
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

// TASK1 — UPSERT meci FT în fixtures_history din obiectul /fixtures (fx).
// Toate câmpurile vin direct din răspunsul API (fx.fixture/teams/goals/league).
async function saveFixtureHistory(fx, season) {
  const fid = fx?.fixture?.id;
  if (!fid) return;
  const status = fx?.fixture?.status?.short || 'FT';
  const hg = fx?.goals?.home;
  const ag = fx?.goals?.away;
  if (hg == null || ag == null) return; // fără scor → nu e util ca istoric
  await dbQuery(
    `INSERT INTO fixtures_history
       (fixture_id, league_id, season, home_team_id, home_team_name,
        away_team_id, away_team_name, match_date, status_short, home_goals, away_goals)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (fixture_id) DO UPDATE SET
       league_id=EXCLUDED.league_id, season=EXCLUDED.season,
       home_team_id=EXCLUDED.home_team_id, home_team_name=EXCLUDED.home_team_name,
       away_team_id=EXCLUDED.away_team_id, away_team_name=EXCLUDED.away_team_name,
       match_date=EXCLUDED.match_date, status_short=EXCLUDED.status_short,
       home_goals=EXCLUDED.home_goals, away_goals=EXCLUDED.away_goals`,
    [
      fid, fx?.league?.id || null, fx?.league?.season || season || null,
      fx?.teams?.home?.id || null, fx?.teams?.home?.name || null,
      fx?.teams?.away?.id || null, fx?.teams?.away?.name || null,
      fx?.fixture?.date || null, status, hg, ag,
    ]
  );
}

// FIX 3 — buildH2H: populează tabela h2h (row-per-fixture) din fixtures_history.
// Schema h2h e per-meci (UNIQUE team1,team2,fixture); agregările pct_over_15/total
// etc. sunt computate query-side în api/generator.js, NU coloane pe h2h.
// Refresh marker în app_settings → re-rulează cel mult o dată la 30 zile per pereche.
async function buildH2H(homeId, awayId) {
  if (!homeId || !awayId || homeId === awayId) return;
  const team1 = Math.min(homeId, awayId);
  const team2 = Math.max(homeId, awayId);

  const refreshKey = `h2h_refresh:${team1}:${team2}`;
  const lastRefresh = await getSetting(refreshKey);
  if (lastRefresh && Date.now() - Number(lastRefresh) < 30 * 86400 * 1000) return;

  const { rows } = await dbQuery(
    `SELECT fixture_id, home_team_id, away_team_id, home_goals, away_goals,
            match_date, league_id, season
       FROM fixtures_history
      WHERE ((home_team_id = $1 AND away_team_id = $2)
          OR (home_team_id = $2 AND away_team_id = $1))
        AND status_short = 'FT'
        AND home_goals IS NOT NULL
        AND match_date >= NOW() - INTERVAL '2 years'
      ORDER BY match_date DESC
      LIMIT 10`,
    [team1, team2]
  );

  if (!rows.length) {
    // Marchez refresh-ul ca să nu mai rulez aceleași query-uri imediat
    await setSetting(refreshKey, String(Date.now()));
    return;
  }

  for (const r of rows) {
    await dbQuery(
      `INSERT INTO h2h
         (team1_id, team2_id, fixture_id, home_team_id, away_team_id,
          match_date, home_goals, away_goals, league_id, season)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (team1_id, team2_id, fixture_id) DO UPDATE SET
         home_goals=EXCLUDED.home_goals,
         away_goals=EXCLUDED.away_goals,
         match_date=EXCLUDED.match_date,
         league_id=EXCLUDED.league_id,
         season=EXCLUDED.season`,
      [
        team1, team2, r.fixture_id,
        r.home_team_id, r.away_team_id,
        r.match_date, r.home_goals, r.away_goals,
        r.league_id, r.season,
      ]
    );
  }

  await setSetting(refreshKey, String(Date.now()));
}

// ── Core: process one league+season ──────────────────────────────────────────────────────

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

  // FIX3 — procesare în batch-uri concurente. Mărimea batch-ului e DINAMICĂ:
  // 5 când stabilizarea rulează (evită epuizarea pool-ului DB), altfel 10.
  // Graceful stop: verifică stopFlag ÎNTRE batch-uri (termină batch-ul curent).
  const cutoff = new Date('2024-05-30');
  let fi = startFi;
  while (fi < fixtures.length) {
    if (stopFlag) {
      await savePosition(si, li, fi);
      await query(
        `UPDATE backfill_progress SET current_fixture_index=$1 WHERE league_id=$2`,
        [fi, leagueId]
      ).catch(() => {});
      return;
    }

    const conc  = currentConcurrency();
    const batch = fixtures.slice(fi, fi + conc);
    currentFixtureIdx = fi;

    // FIX5 — skip-check BATCH: un singur query per tip pentru toate fixture-urile
    // din batch (în loc de 6 query-uri × fixture). Reduce drastic query-urile DB.
    const fids = batch
      .map(fx => fx?.fixture?.id)
      .filter(Boolean);
    const [statsSet, eventsSet, playersSet, nodataSet] = await Promise.all([
      dbQuery('SELECT DISTINCT fixture_id FROM match_stats  WHERE fixture_id = ANY($1)', [fids]).then(r => new Set(r.rows.map(x => x.fixture_id))).catch(() => new Set()),
      dbQuery('SELECT DISTINCT fixture_id FROM match_events WHERE fixture_id = ANY($1)', [fids]).then(r => new Set(r.rows.map(x => x.fixture_id))).catch(() => new Set()),
      dbQuery('SELECT DISTINCT fixture_id FROM player_stats WHERE fixture_id = ANY($1)', [fids]).then(r => new Set(r.rows.map(x => x.fixture_id))).catch(() => new Set()),
      dbQuery('SELECT key FROM app_settings WHERE key = ANY($1)',
            [fids.flatMap(id => [`no_data:stats:${id}`, `no_data:events:${id}`, `no_data:players:${id}`])])
        .then(r => new Set(r.rows.map(x => x.key))).catch(() => new Set()),
    ]);

    await Promise.all(batch.map(async (fx) => {
      const fid = fx?.fixture?.id;
      if (!fid) return;
      // Retenție 2 ani: skip meciuri mai vechi de cutoff
      const _mDate = fx?.fixture?.date;
      if (_mDate && new Date(_mDate) < cutoff) return;
      const hid = fx?.teams?.home?.id;
      const aid = fx?.teams?.away?.id;

      if (!statsSet.has(fid)   && !nodataSet.has(`no_data:stats:${fid}`))   { try { await collectStats(fid);   } catch (e) { log(`stats   ${fid}: ${e.message}`); } }
      if (!eventsSet.has(fid)  && !nodataSet.has(`no_data:events:${fid}`))  { try { await collectEvents(fid);  } catch (e) { log(`events  ${fid}: ${e.message}`); } }
      if (!playersSet.has(fid) && !nodataSet.has(`no_data:players:${fid}`)) { try { await collectPlayers(fid); } catch (e) { log(`players ${fid}: ${e.message}`); } }

      // TASK1 — UPSERT în fixtures_history (DUPĂ stats/events/players). Repară
      // lacuna structurală: backfill colecta date brute dar nu istoricul FT →
      // h2h/form/league-stats rămâneau goale pentru sezoanele backfill-uite.
      try { await saveFixtureHistory(fx, season); } catch (e) { log(`history ${fid}: ${e.message}`); }

      if (hid && aid && hid !== aid) {
        try { await buildH2H(hid, aid); } catch (e) { log(`h2h ${hid}-${aid}: ${e.message}`); }
      }
      totalProcessed++;
    }));

    fi += conc;
    await savePosition(si, li, Math.min(fi, fixtures.length));
  }

  // League+season done — reset fixture index
  await savePosition(si, li + 1, 0);
  await query(
    `UPDATE backfill_progress
     SET current_fixture_index=$1, total_fixtures=$2 WHERE league_id=$3`,
    [fixtures.length, fixtures.length, leagueId]
  ).catch(() => {});
}

// ── Core: main loop ──────────────────────────────────────────────────────────────────────────────

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

// ── Exports ───────────────────────────────────────────────────────────────────────────────────

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

export async function startBackfill(opts = {}) {
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
  totalProcessed = 0;
  _startTs = Date.now();

  // FIX6 — START țintit pe ligă/sezon specific (resetează poziția la acel punct).
  // opts: { leagueId, season }. Dacă lipsesc → RESUME din poziția salvată.
  let si, li, fi;
  const optLeague = opts.leagueId ? Number(opts.leagueId) : null;
  const optSeason = opts.season ? Number(opts.season) : null;
  if (optLeague || optSeason) {
    si = optSeason != null ? Math.max(0, SEASONS.indexOf(optSeason)) : 0;
    li = optLeague != null ? Math.max(0, LEAGUE_IDS.indexOf(optLeague)) : 0;
    fi = 0;
    await savePosition(si, li, fi);
    log(`Targeted start: season=${SEASONS[si]} league=${LEAGUE_IDS[li]}`);
  } else {
    // Load resume position
    si = Math.min(parseInt(await getSetting('backfill_season_idx')  || '0'), SEASONS.length - 1);
    li = Math.min(parseInt(await getSetting('backfill_league_idx')  || '0'), LEAGUE_IDS.length - 1);
    fi = parseInt(await getSetting('backfill_fixture_idx') || '0');
  }

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

  // FIX6 — viteză reală (fixture/min) din sesiunea curentă + ETA bazat pe ea.
  let speedPerMin = null, estimatedMs;
  if (running && _startTs && totalProcessed > 0) {
    const elapsedMin = (Date.now() - _startTs) / 60000;
    if (elapsedMin > 0.05) speedPerMin = Math.round(totalProcessed / elapsedMin);
  }
  const remainingPairs = Math.max(0, totalPairs - completedPairs);
  if (speedPerMin && totalFixtures > 0) {
    // estimare pe baza fixture-urilor rămase × viteză măsurată
    const remFixturesInLeague = Math.max(0, totalFixtures - fi);
    const remFixtures = remFixturesInLeague + remainingPairs * (totalFixtures || 30);
    estimatedMs = (remFixtures / speedPerMin) * 60000;
  } else {
    estimatedMs = remainingPairs * 10 * DELAY_MS; // fallback brut
  }

  // FIX2 — afișează limita REALĂ a planului (300k), nu un STOP_AT artificial.
  const planLimit = parseInt(await getSetting('backfill_api_limit') || String(API_PLAN_LIMIT));

  return {
    running,
    currentLeague:       lid ? { id: lid, name: leagueName } : null,
    currentSeason:       season,
    currentFixtureIndex: fi,
    totalFixtures,
    totalProcessedSession: totalProcessed,
    speedPerMin,
    totalLeagues:        totalPairs,
    completedLeagues:    completedPairs,
    progressPct,
    apiUsedToday:        usedToday,
    apiPlanLimit:        planLimit,
    apiRemainingToday:   Math.max(0, planLimit - usedToday),
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
