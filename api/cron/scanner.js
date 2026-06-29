// api/cron/scanner.js
// Modul continuu — pornit din server.js la startup via startScanner().
// Înlocuiește crontab-ul "* * * * *" al cron/scan.js cu 3 timere setInterval.
//
// Ciclu 1 — scanLive10s   — la fiecare  10 secunde
// Ciclu 2 — scanLiveStats — la fiecare  60 secunde
// Ciclu 3 — scanPreMatch  — la fiecare  60 minute
//
// scan.js rămâne neschimbat (disponibil manual la /api/cron/scan).

import { query } from '../db.js';
import { logPrediction } from '../log-prediction.js';
import { ALLOWED_LEAGUE_IDS } from '../leagues.js';
import { isAllowedMatch } from '../utils/league-filter.js';
import { calcFeatures, calcNextGoal, calcNextGoalWindow, calcGG, calcMarkets } from '../utils/live-score.js';
import { calibrateNgp, isShadowFixture, calibrateNgpWithTimedecay } from '../utils/ngp-calibration.js';
import { trackElapsed, freezeReason, maybeLogFrozen, clearFreeze, snapshotFreeze, restoreFreeze } from '../utils/freeze-state.js';

const FOOTBALL_KEY = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;

const LIVE_STATUS = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT']);
const DONE_STATUS = new Set(['FT', 'AET', 'PEN']);
// Statusuri terminale EXTRA (meci ne-jucat/anulat/amânat) — scoatem cardul din live.
// NU includem SUSP/INT (pot relua — prune-by-absence le acoperă dacă chiar dispar).
const TERMINAL_EXTRA = new Set(['CANC', 'ABD', 'PST', 'WO', 'AWD']);
const LIVE_PRUNE_MS = 90_000;  // prune-by-absence: șterge din liveCache dacă nu mai e văzut 90s
// Freeze-detection (minut înghețat): stare PARTAJATĂ în utils/freeze-state.js
// (_lastElapsed/_frozenSince persistă între re-add-uri). Aici DOAR tracking + filtrare
// la ieșire — NU mai ștergem liveCache pe motiv de îngheț (evită bucla delete/re-add).

// Stare în memorie
const liveCache         = {}; // { [fixtureId]: { home_goals, away_goals, status, minute, lineupsFetched } }
const prematchCache     = {}; // { [fixtureId]: { ts, composite } }
const _lastBroadcastSnap = {}; // { [fixtureId]: snap string } — pentru delta updates

let _scanCounter = 0;

function getMatchPriority(m) {
  const sh  = m.fixture?.status?.short || '';
  const mn  = m.fixture?.status?.elapsed ?? 0;
  const hg  = m.goals?.home ?? 0;
  const ag  = m.goals?.away ?? 0;
  const diff = Math.abs(hg - ag);
  if (DONE_STATUS.has(sh) || sh === 'HT') return 'low';
  // Aliniat cu matchPriorityBucket: mn≥50 OR diff≤1 → HIGH (un meci HIGH în bucket
  // nu mai e throttle-uit la fetch-ul de detaliu). NGP nu e disponibil aici (fără
  // input prevNg), deci folosim doar minut + diferența de scor.
  if (mn >= 50 || diff <= 1) return 'high';
  return 'medium';
}

async function fetchWithRetry(path, maxRetries = 2) {
  const url = `https://v3.football.api-sports.io${path}`;
  const headers = { 'x-apisports-key': FOOTBALL_KEY };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const r = await fetch(url, { headers });
      if (r.status === 429) {
        const wait = attempt === 0 ? 30_000 : 60_000;
        log(`fetchWithRetry 429 on ${path} — waiting ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      const d = await r.json();
      return d.response || [];
    } catch (e) {
      if (attempt === maxRetries) throw e;
      await sleep(2000);
    }
  }
  return [];
}

const formCache = {}; // { [key]: { ts, val } }
const FORM_CACHE_TTL = 3_600_000; // 1 hour
const FORM_CACHE_MAX = 500;

function evictFormCache() {
  const keys = Object.keys(formCache);
  if (keys.length > FORM_CACHE_MAX) {
    keys.slice(0, Math.floor(FORM_CACHE_MAX / 2)).forEach(k => delete formCache[k]);
  }
}

function log(msg) { console.log(`[scanner] ${new Date().toISOString()} ${msg}`); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getFormGoals(teamId, isHome) {
  const cKey = `${teamId}:${isHome ? 'h' : 'a'}`;
  const hit = formCache[cKey];
  if (hit && (Date.now() - hit.ts) < FORM_CACHE_TTL) return hit.val;
  try {
    // Încearcă tabelul fixtures (dacă e populat)
    const col   = isHome ? 'home_goals' : 'away_goals';
    const idCol = isHome ? 'home_team_id' : 'away_team_id';
    const r = await query(
      `SELECT AVG(sub.g::numeric) AS avg_g, COUNT(*) AS cnt FROM (
         SELECT ${col} AS g FROM fixtures_history
         WHERE ${idCol} = $1 AND status_short = 'FT' AND ${col} IS NOT NULL
         ORDER BY match_date DESC LIMIT 10
       ) sub`,
      [teamId]
    );
    const row = r.rows[0];
    if (row && parseInt(row.cnt) >= 3) {
      const val = parseFloat(row.avg_g) || 0.35;
      formCache[cKey] = { ts: Date.now(), val };
      return val;
    }
    // Fallback: player_stats — suma goluri per meci pentru această echipă
    const r2 = await query(
      `SELECT AVG(team_goals::numeric) AS avg_g, COUNT(*) AS cnt FROM (
         SELECT fixture_id, SUM(goals) AS team_goals
         FROM player_stats
         WHERE team_id = $1
         GROUP BY fixture_id
         ORDER BY fixture_id DESC
         LIMIT 10
       ) sub`,
      [teamId]
    );
    const row2 = r2.rows[0];
    const val = (row2 && parseInt(row2.cnt) >= 3) ? (parseFloat(row2.avg_g) || 0.35) : 0.35;
    evictFormCache();
    formCache[cKey] = { ts: Date.now(), val };
    return val;
  } catch (_) {
    return 0.35;
  }
}

async function apiFetch(path) {
  const r = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { 'x-apisports-key': FOOTBALL_KEY },
  });
  const d = await r.json();
  return d.response || [];
}

// ── Scoring — extras în api/utils/live-score.js ───────────────────────────────
// Funcțiile poissonProb/mkt/getStat/calcFeatures/calcNextGoal/calcGG/calcMarkets
// sunt importate la începutul fișierului din ../utils/live-score.js

// ── DB helpers — copiate verbatim din cron/scan.js ────────────────────────────

// Asigura coloana ng_15min exista (idempotent, ruleaza o singura data la boot)
let _ng15ColumnEnsured = false;
async function ensureNg15Column() {
  if (_ng15ColumnEnsured) return;
  try {
    await query(`ALTER TABLE match_snapshots ADD COLUMN IF NOT EXISTS ng_15min INTEGER`);
    _ng15ColumnEnsured = true;
  } catch (e) {
    log(`ALTER TABLE ng_15min skipped: ${e.message}`);
  }
}

async function upsertSnapshot(row) {
  await ensureNg15Column();
  await query(
    `INSERT INTO match_snapshots
       (fixture_id, league_id, home_team, away_team,
        status_short, minute, home_goals, away_goals,
        ng, over15, outcome, ng_15min)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (fixture_id) DO UPDATE SET
       status_short=EXCLUDED.status_short,
       minute=EXCLUDED.minute,
       home_goals=EXCLUDED.home_goals,
       away_goals=EXCLUDED.away_goals,
       ng=EXCLUDED.ng,
       over15=EXCLUDED.over15,
       outcome=EXCLUDED.outcome,
       ng_15min=EXCLUDED.ng_15min`,
    [
      row.fixture_id, row.league_id, row.home_team, row.away_team,
      row.status_short, row.minute, row.home_goals, row.away_goals,
      row.ng, row.over15, row.outcome || 'LIVE', row.ng_15min ?? null,
    ]
  );
}

async function resolveOutcome(fixtureId, outcome, finalHome, finalAway) {
  await query(
    `UPDATE match_snapshots
     SET outcome=$1, final_home=$2, final_away=$3, resolved_at=NOW()
     WHERE fixture_id=$4`,
    [outcome, finalHome, finalAway, fixtureId]
  );
}

// FIX PROSPEȚIME FT: când scannerul prinde finalul unui meci live, scrie INSTANT
// scorul/status-ul final în tabela fixtures (UPDATE idempotent, NU creează rândul) —
// cardul devine proaspăt la secunda finalului, fără să aștepte cronul de dimineață.
// Golurile lipsă din payload-ul live păstrează valoarea existentă (COALESCE).
async function freshenFixtureFinal(m, fixtureId, statusShort) {
  const hg = m.goals?.home;
  const ag = m.goals?.away;
  const htH = m.score?.halftime?.home;
  const htA = m.score?.halftime?.away;
  await query(
    `UPDATE fixtures
       SET status_short = $2,
           home_goals   = COALESCE($3, home_goals),
           away_goals   = COALESCE($4, away_goals),
           home_ht      = COALESCE($5, home_ht),
           away_ht      = COALESCE($6, away_ht),
           updated_at   = NOW()
     WHERE fixture_id = $1`,
    [fixtureId, statusShort,
     (hg ?? null), (ag ?? null), (htH ?? null), (htA ?? null)]
  );
}

// M5: Save FT match to fixtures_history and update form_stats for both teams
async function saveFormStats(m) {
  const fid    = m.fixture?.id;
  const hid    = m.teams?.home?.id;
  const aid    = m.teams?.away?.id;
  const lid    = m.league?.id;
  const hg     = m.goals?.home ?? null;
  const ag     = m.goals?.away ?? null;
  const dt     = m.fixture?.date || new Date().toISOString();
  const season = new Date().getFullYear();

  if (!fid || !hid || !aid || hg === null || ag === null) return;

  try {
    // FIX logo: UPSERT echipele (id/name/logo din payload-ul live) ÎNAINTE de history.
    for (const side of ['home', 'away']) {
      const t = m.teams?.[side];
      if (t?.id) await query(
        `INSERT INTO teams (team_id, name, logo, updated_at) VALUES ($1,$2,$3,NOW())
           ON CONFLICT (team_id) DO UPDATE SET name=EXCLUDED.name,
             logo=COALESCE(EXCLUDED.logo, teams.logo), updated_at=NOW()`,
        [t.id, t.name || null, t.logo || null]
      ).catch(() => {});
    }
    await query(`
      INSERT INTO fixtures_history
        (fixture_id, league_id, season,
         home_team_id, home_team_name, away_team_id, away_team_name,
         home_goals, away_goals, status_short, match_date, referee)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'FT',$10,$11)
      ON CONFLICT (fixture_id) DO UPDATE SET
        home_goals=EXCLUDED.home_goals, away_goals=EXCLUDED.away_goals, status_short='FT',
        referee=COALESCE(EXCLUDED.referee, fixtures_history.referee)
    `, [fid, lid, season, hid, m.teams?.home?.name || '', aid, m.teams?.away?.name || '', hg, ag, dt, m.fixture?.referee || null]);

    const hr = await query(`
      SELECT
        string_agg(CASE WHEN home_goals>away_goals THEN 'W' WHEN home_goals=away_goals THEN 'D' ELSE 'L' END,
                   '' ORDER BY match_date DESC) AS last5,
        AVG(home_goals)::NUMERIC(5,2) AS avg_scored,
        AVG(away_goals)::NUMERIC(5,2) AS avg_conceded
      FROM (SELECT home_goals,away_goals,match_date FROM fixtures_history
            WHERE home_team_id=$1 AND status_short='FT' AND home_goals IS NOT NULL
            ORDER BY match_date DESC LIMIT 5) sub
    `, [hid]);
    if (hr.rows[0]?.avg_scored !== null) {
      const r = hr.rows[0];
      await query(`
        INSERT INTO form_stats (team_id,league_id,season,last5_home,avg_scored_home,avg_conceded_home,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (team_id,league_id,season) DO UPDATE SET
          last5_home=EXCLUDED.last5_home, avg_scored_home=EXCLUDED.avg_scored_home,
          avg_conceded_home=EXCLUDED.avg_conceded_home, updated_at=NOW()
      `, [hid, lid, season, r.last5, r.avg_scored, r.avg_conceded]);
    }

    const ar = await query(`
      SELECT
        string_agg(CASE WHEN away_goals>home_goals THEN 'W' WHEN away_goals=home_goals THEN 'D' ELSE 'L' END,
                   '' ORDER BY match_date DESC) AS last5,
        AVG(away_goals)::NUMERIC(5,2) AS avg_scored,
        AVG(home_goals)::NUMERIC(5,2) AS avg_conceded
      FROM (SELECT home_goals,away_goals,match_date FROM fixtures_history
            WHERE away_team_id=$1 AND status_short='FT' AND away_goals IS NOT NULL
            ORDER BY match_date DESC LIMIT 5) sub
    `, [aid]);
    if (ar.rows[0]?.avg_scored !== null) {
      const r = ar.rows[0];
      await query(`
        INSERT INTO form_stats (team_id,league_id,season,last5_away,avg_scored_away,avg_conceded_away,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (team_id,league_id,season) DO UPDATE SET
          last5_away=EXCLUDED.last5_away, avg_scored_away=EXCLUDED.avg_scored_away,
          avg_conceded_away=EXCLUDED.avg_conceded_away, updated_at=NOW()
      `, [aid, lid, season, r.last5, r.avg_scored, r.avg_conceded]);
    }
  } catch (e) {
    log(`saveFormStats ${fid}: ${e.message}`);
  }
}

async function saveLiveStats(m, f, status) {
  // Bug fix: live_stats.ngp_home/ngp_away rămâneau NULL — INSERT-ul nu le
  // includea. Calculează NGP total local (calcNextGoal + calibrare) și
  // împărțit proporțional cu xG-ul per echipă. Fallback 50/50 dacă xG=0.
  let ngpHome = null, ngpAway = null;
  const ngTotal = f.mn < 10 ? 0 : calibrateNgp(calcNextGoal(f));
  if (ngTotal > 0) {
    const hxg = Math.max(0, f.hxg || 0);
    const axg = Math.max(0, f.axg || 0);
    const sum = hxg + axg;
    if (sum > 0) {
      ngpHome = +(ngTotal * (hxg / sum)).toFixed(2);
      ngpAway = +(ngTotal * (axg / sum)).toFixed(2);
    } else {
      ngpHome = +(ngTotal / 2).toFixed(2);
      ngpAway = +(ngTotal / 2).toFixed(2);
    }
  }

  await query(
    `INSERT INTO live_stats
       (fixture_id, elapsed, home_goals, away_goals,
        home_sot, away_sot, home_shots, away_shots,
        home_possession, away_possession,
        home_corners, away_corners,
        home_da, away_da,
        home_xg, away_xg,
        ngp_home, ngp_away)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      m.fixture.id,
      f.mn,
      f.hg,
      f.ag,
      f.hSOT,
      f.aSOT,
      f.hSh,
      f.aSh,
      f.hp,
      100 - (f.hp || 50),
      f.hC,
      f.aC,
      f.hDA,
      f.aDA,
      f.hxg || null,
      f.axg || null,
      ngpHome,
      ngpAway,
    ]
  );
}


// Variant A — modul calibrare: meciurile fără date complete (lineups reale ≥7/11
// ambele) NU intră în semnalul live de bani reali când LIVE_REQUIRE_FULL_DATA=true;
// sunt salvate în signal_observations cu confidence-ul lor, pt. măsurat win-rate.
// Decizia e DOAR în stratul de output/selecție — NU atinge calcConfidence/score-uri.
const LIVE_REQUIRE_FULL_DATA = String(process.env.LIVE_REQUIRE_FULL_DATA || '').toLowerCase() === 'true';

async function ensureObservationTable() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS signal_observations (
        id            SERIAL PRIMARY KEY,
        fixture_id    INTEGER,
        alert_type    TEXT,
        market        TEXT,
        message       TEXT,
        confidence    NUMERIC(6,3),
        data_completeness TEXT,
        minute        INTEGER,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )`);
  } catch (_) {}
}

// Date complete pentru ACEST meci (output-layer): formații reale ≥7/11 titulari
// pe ambele echipe (prematch_data lineups). Citire DB, fără API. Refolosește
// aceeași sursă ca getLineupStrengthFactor din enrich (consistență).
async function matchHasFullData(fixtureId, hId, aId) {
  try {
    const { rows } = await query(
      `SELECT payload FROM prematch_data WHERE fixture_id=$1 AND data_type='lineups'
       ORDER BY stage DESC LIMIT 1`, [fixtureId]);
    if (!rows.length) return false;
    const lu = rows[0].payload;
    if (!Array.isArray(lu) || lu.length < 2) return false;
    const find = (id) => lu.find(t => t.team?.id === id);
    const h = find(hId), a = find(aId);
    if (!h || !a) return false;
    const n = (e) => (e.startXI || []).map(p => p.player?.id).filter(Boolean).length;
    return n(h) >= 7 && n(a) >= 7;
  } catch (_) { return false; }
}

async function saveAlert(fixtureId, alertType, market, message, confidence) {
  await query(
    `INSERT INTO alerts (fixture_id, alert_type, message, ngp_value, telegram_ok)
     SELECT $1,$2,$3,$4,FALSE
     WHERE NOT EXISTS (
       SELECT 1 FROM alerts
       WHERE fixture_id=$1 AND alert_type=$2
         AND sent_at > NOW() - INTERVAL '2 hours'
     )`,
    [fixtureId, alertType, message, confidence || null]
  );
}

// ── mn6: Rezolvare robustă WIN/LOSS NGP — verifică FT în DB ─────────────────

async function resolveNGPOutcomes(liveMatches) {
  const liveMap = new Map(liveMatches.map(m => [m.fixture?.id, m]));

  const { rows: pending } = await query(`
    SELECT fixture_id, score_at_alert, created_at
    FROM predictions
    WHERE outcome_ngp = 'PENDING'
      AND score_at_alert IS NOT NULL
      AND created_at < NOW() - INTERVAL '5 minutes'
  `).catch(() => ({ rows: [] }));

  for (const pred of pending) {
    const fid = pred.fixture_id;
    const liveMatch = liveMap.get(fid);

    if (liveMatch) {
      // Meciul e încă live — WIN dacă s-a marcat gol după alertă
      const [ah, aa] = (pred.score_at_alert || '0-0').split('-').map(Number);
      const alertTotal = (ah || 0) + (aa || 0);
      const curTotal   = (liveMatch.goals?.home || 0) + (liveMatch.goals?.away || 0);
      if (curTotal > alertTotal) {
        query(`UPDATE predictions SET outcome_ngp='WIN', updated_at=NOW() WHERE fixture_id=$1 AND outcome_ngp='PENDING'`, [fid]).catch(() => {});
      }
    } else {
      // Meciul a dispărut din live — verifică în fixtures_history dacă e FT
      const { rows: ftRows } = await query(
        `SELECT status_short FROM fixtures_history WHERE fixture_id=$1`,
        [fid]
      ).catch(() => ({ rows: [] }));

      if (ftRows[0]?.status_short === 'FT') {
        // Confirmat terminat — LOSS (nu s-a marcat gol după alertă — altfel era WIN deja)
        query(`UPDATE predictions SET outcome_ngp='LOSS', updated_at=NOW() WHERE fixture_id=$1 AND outcome_ngp='PENDING'`, [fid]).catch(() => {});
      } else {
        // Status necunoscut — aşteaptă max 3h, apoi forţează LOSS
        const ageH = (Date.now() - new Date(pred.created_at).getTime()) / 3_600_000;
        if (ageH > 3) {
          query(`UPDATE predictions SET outcome_ngp='LOSS', updated_at=NOW() WHERE fixture_id=$1 AND outcome_ngp='PENDING'`, [fid]).catch(() => {});
        }
      }
    }
  }
}

// [P03] Persistență freeze-state în app_settings (restart-proof). Salvare throttled la 30s.
let _freezePersistAt = 0;
async function persistFreezeState() {
  const now = Date.now();
  if (now - _freezePersistAt < 30_000) return;
  _freezePersistAt = now;
  try {
    await query(
      `INSERT INTO app_settings (key, value) VALUES ('freeze_state', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(snapshotFreeze())]
    );
  } catch (_) { /* best-effort */ }
}
async function loadFreezeState() {
  try {
    await query(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`);
    const r = await query(`SELECT value FROM app_settings WHERE key = 'freeze_state'`);
    if (r.rows[0]?.value) restoreFreeze(JSON.parse(r.rows[0].value));
  } catch (_) { /* fără stare salvată → comportament ca înainte */ }
}

// ── Ciclu 1: /fixtures?live=all — la fiecare 10 secunde ──────────────────────

async function scanLive10s() {
  if (!FOOTBALL_KEY) return;
  _scanCounter++;
  try {
    const rawAll = await fetchWithRetry('/fixtures?live=all');
    const raw = rawAll.filter(m => isAllowedMatch(m, ALLOWED_LEAGUE_IDS));
    log(`live10s: ${rawAll.length} din API → ${raw.length} după filtrare`);

    // lastSeen: marchează FIECARE meci prezent în `raw` în ciclul curent — INDIFERENT
    // de throttling (LOW/MEDIUM sunt în `raw`, deci „văzute" → NU vor fi pruned). Folosit
    // la prune-by-absence: un meci care dispare din live=all fără FT prins se curăță.
    // În același loop urmărim și MINUTUL (trackElapsed, stare partajată freeze-state):
    // unele meciuri vin cu status de joc dar `elapsed` blocat → le FILTRĂM la ieșire.
    const _nowSeen = Date.now();
    for (const m of raw) {
      const _id = m.fixture?.id;
      if (!_id) continue;
      if (!liveCache[_id]) liveCache[_id] = {};
      liveCache[_id].lastSeen = _nowSeen;
      trackElapsed(_id, m.fixture?.status?.elapsed ?? 0, m.fixture?.status?.short || '');
    }

    // Prefetch real form goals per team (cached 1h in formCache)
    const matchFd = {};
    await Promise.allSettled(raw.map(async m => {
      const hId = m.teams?.home?.id;
      const aId = m.teams?.away?.id;
      if (!hId || !aId) return;
      const [hG, aG] = await Promise.all([getFormGoals(hId, true), getFormGoals(aId, false)]);
      matchFd[m.fixture?.id] = {
        homeFormGoals: hG,
        awayFormGoals: aG,
        homeFormGG:    Math.min(0.95, hG / 1.2),
        awayFormGG:    Math.min(0.95, aG / 1.2),
        h2hGoalRate:   Math.min(0.90, (hG + aG) / 4),
        h2hGGRate:     Math.min(0.90, (hG + aG) / 3.5),
      };
    }));

    const processedMatches = [];
    const finishedThisCycle = {};   // [P02] id → scor final, pt semnalul de removal pe WS

    // FIX 3: priority buckets 3-tier (la 2s cadența scanLive10s):
    //   HIGH   — mn≥50 OR NGP>40 OR diff≤1 → fiecare scan (2s)
    //   MEDIUM — restul (mn 30-49, diff 2)  → fiecare al 2-lea scan (4s)
    //   LOW    — mn<30 ȘI diff>2            → fiecare al 4-lea scan (8s)
    function matchPriorityBucket(m, prevNg) {
      const mn = m.fixture?.status?.elapsed ?? 0;
      const hg = m.goals?.home ?? 0;
      const ag = m.goals?.away ?? 0;
      const diff = Math.abs(hg - ag);
      const ng = prevNg || 0;
      if (mn >= 50 || ng > 40 || diff <= 1) return 'high';
      if (mn < 30 && diff > 2)                return 'low';
      return 'medium';
    }

    for (const m of raw) {
      const sh = m.fixture?.status?.short || '';
      const id = m.fixture?.id;
      if (!id) continue;

      // Skip pe bucket: high = mereu, medium = 1/2, low = 1/4
      if (LIVE_STATUS.has(sh)) {
        const prevNg = liveCache[id]?.ngLast || 0;
        const bucket = matchPriorityBucket(m, prevNg);
        if (bucket === 'low'    && (_scanCounter % 4) !== 0) continue;
        if (bucket === 'medium' && (_scanCounter % 2) !== 0) continue;
        // high → fall through (procesare la fiecare scan)
      }

      // Meci terminat — rezolvă outcome dacă îl urmăream
      if (DONE_STATUS.has(sh)) {
        const fh = m.goals?.home ?? 0;
        const fa = m.goals?.away ?? 0;
        // [P02] reține tranziția FT cu scorul final → broadcast removal către UI.
        finishedThisCycle[id] = { home: fh, away: fa, status: sh };
        // FIX PROSPEȚIME FT: scrie INSTANT scorul final în fixtures (toate meciurile
        // scanate live, nu doar WC) — UPDATE idempotent, fără creare de rând.
        freshenFixtureFinal(m, id, sh).catch(e => log(`freshenFixtureFinal ${id}: ${e.message}`));
        if (liveCache[id]) {
          resolveOutcome(id, (fh + fa) >= 2 ? 'WIN' : 'LOSS', fh, fa)
            .catch(e => log(`resolveOutcome ${id}: ${e.message}`));
          saveFormStats(m).catch(e => log(`saveFormStats ${id}: ${e.message}`)); // M5
          delete liveCache[id];
        }
        clearFreeze(id);
        continue;
      }

      // Statusuri terminale extra (CANC/ABD/PST/WO/AWD) — scoatem cardul din live.
      // NU rezolvăm outcome (scor incert) — collect-finished face rezolvarea reală.
      if (TERMINAL_EXTRA.has(sh)) {
        if (liveCache[id]) delete liveCache[id];
        delete _lastBroadcastSnap[id];
        clearFreeze(id);
        continue;
      }

      if (!LIVE_STATUS.has(sh)) continue;

      // Priority throttling: medium every 2nd scan, low every 5th
      const priority = getMatchPriority(m);
      if (priority === 'medium' && _scanCounter % 2 !== 0) { processedMatches.push(m); continue; }
      if (priority === 'low'    && _scanCounter % 5 !== 0) { processedMatches.push(m); continue; }

      const currHome = m.goals?.home ?? 0;
      const currAway = m.goals?.away ?? 0;
      const currMin  = m.fixture?.status?.elapsed ?? 0;
      const prev     = liveCache[id];

      if (!prev) {
        // Prima apariție — fetch lineups o singură dată
        liveCache[id] = {
          home_goals: currHome, away_goals: currAway,
          status: sh, minute: currMin, lineupsFetched: true,
          formData: matchFd[id] || {},
        };
        fetchWithRetry(`/fixtures/lineups?fixture=${id}`)
          .then(lineups => { if (liveCache[id]) liveCache[id].lineups = lineups; })
          .catch(() => {});
      } else {
        // Scorul s-a schimbat — fetch events imediat
        if (prev.home_goals !== currHome || prev.away_goals !== currAway) {
          log(`score change ${id}: ${currHome}-${currAway}`);
          fetchWithRetry(`/fixtures/events?fixture=${id}`)
            .then(events => { if (liveCache[id]) liveCache[id].events = events; })
            .catch(() => {});
        }
        liveCache[id].home_goals = currHome;
        liveCache[id].away_goals = currAway;
        liveCache[id].status     = sh;
        liveCache[id].minute     = currMin;
        liveCache[id].formData   = matchFd[id] || liveCache[id].formData || {};
      }

      // Calcul scoring + upsert snapshot
      // V1_sotDerived formula (cea mai bună la backtest: Brier 0.2573):
      // override homeFormGoals/awayFormGoals din SOT live (SOT/mn * 9)
      // când SOT prezent, fallback la form DB istoric altfel.
      const f  = calcFeatures(m, matchFd[id] || {});
      if (f.mn > 0 && f.hSOT > 0) f.homeFormGoals = (f.hSOT / f.mn) * 9;
      if (f.mn > 0 && f.aSOT > 0) f.awayFormGoals = (f.aSOT / f.mn) * 9;
      const ngRaw = calcNextGoal(f);
      const ng15Raw = calcNextGoalWindow(f, 15);
      // Hide NGP în primele 10 min (date insuficiente pentru încredere)
      // [FEATURE_NGP_TIMEDECAY] Shadow determinist 10% (id%100<10) DOAR când flag-ul
      // e ON. Off (default) → calibrateNgp existent → comportament IDENTIC cu producția.
      const _ngTimedecay = process.env.FEATURE_NGP_TIMEDECAY === 'true' && isShadowFixture(id);
      let ng;
      if (f.mn < 10) {
        ng = 0;
      } else if (_ngTimedecay) {
        const _ngBase = calibrateNgp(ngRaw);
        ng = calibrateNgpWithTimedecay(ngRaw, f.mn);
        log(`[NGP-SHADOW] fixture=${id} min=${f.mn} raw=${ngRaw} base=${_ngBase} td=${ng}`);
      } else {
        ng = calibrateNgp(ngRaw);
      }
      let ng15 = f.mn < 10 ? 0 : ng15Raw;  // ng15 e deja calibrat prin formula (cap 60)
      // FIX 4: smoothing adaptiv. Pre-minutul 75 = ±5pp (anti-oscilație
      // standard). Min 75-85 = ±15pp (semnale mai responsive în final).
      // Min 85+ = ±25pp (meciuri critice — schimbări dramatice prinse repede).
      const MAX_DELTA = (f.mn >= 85) ? 25 : (f.mn >= 75) ? 15 : 5;
      if (liveCache[id]?.ngLast !== undefined && ng > 0) {
        const prev = liveCache[id].ngLast;
        ng = Math.max(prev - MAX_DELTA, Math.min(prev + MAX_DELTA, ng));
      }
      if (liveCache[id]?.ng15Last !== undefined && ng15 > 0) {
        const prev = liveCache[id].ng15Last;
        ng15 = Math.max(prev - MAX_DELTA, Math.min(prev + MAX_DELTA, ng15));
      }
      if (!liveCache[id]) liveCache[id] = {};
      liveCache[id].ngLast = ng;
      liveCache[id].ng15Last = ng15;
      const mk = calcMarkets(f);

      upsertSnapshot({
        fixture_id:   id,            league_id:  m.league?.id,
        home_team:    m.teams?.home?.name,       away_team: m.teams?.away?.name,
        status_short: sh,            minute:     currMin,
        home_goals:   currHome,      away_goals: currAway,
        ng,           over15: mk.over15,         outcome: 'LIVE',
        ng_15min:     ng15,
      }).catch(e => log(`upsertSnapshot ${id}: ${e.message}`));

      processedMatches.push({ ...m, _ng: ng, _ng15: ng15, _mk: mk });

      // Alerte — o singura data per meci cand NGP trece de 70%
      if (ng > 70 || mk.over15 > 70) {
        const alertType = ng > 70 ? 'HIGH_NGP' : 'HIGH_OVER15';
        const conf      = ng > 70 ? ng / 100 : mk.over15 / 100;
        const msg       = `${m.teams?.home?.name} vs ${m.teams?.away?.name} — ${alertType} ${Math.round(conf * 100)}% min ${currMin}`;

        // Variant A — filtru de OUTPUT (NU calcConfidence): în modul calibrare,
        // meciurile fără date complete merg în observație, nu în semnalul de bani.
        let _full = true;
        if (LIVE_REQUIRE_FULL_DATA) {
          _full = await matchHasFullData(id, m.teams?.home?.id, m.teams?.away?.id);
        }
        if (!_full) {
          await ensureObservationTable();
          query(
            `INSERT INTO signal_observations (fixture_id, alert_type, market, message, confidence, data_completeness, minute)
             VALUES ($1,$2,$3,$4,$5,'partial',$6)`,
            [id, alertType, ng > 70 ? 'ng' : 'over15', msg, conf, currMin]
          ).catch(() => {});
        } else {
          saveAlert(id, alertType, ng > 70 ? 'ng' : 'over15', msg, conf).catch(() => {});

        // Track in predictions for header W/L/P counter
        if (ng > 70 && !liveCache[id]?.ngpAlertScore) {
          const alertScore = `${currHome}-${currAway}`;
          liveCache[id].ngpAlertScore = alertScore;
          query(
            `INSERT INTO predictions
               (fixture_id, home_team, away_team, match_date, score_at_alert, outcome_ngp, league_id, league_name)
             VALUES ($1,$2,$3,NOW(),$4,'PENDING',$5,$6)
             ON CONFLICT (fixture_id) DO UPDATE SET
               score_at_alert = CASE WHEN predictions.score_at_alert IS NULL
                                     THEN EXCLUDED.score_at_alert
                                     ELSE predictions.score_at_alert END,
               outcome_ngp    = CASE WHEN predictions.score_at_alert IS NULL
                                     THEN 'PENDING'
                                     ELSE predictions.outcome_ngp END,
               updated_at = NOW()`,
            [id, m.teams?.home?.name, m.teams?.away?.name, alertScore, m.league?.id, m.league?.name]
          ).catch(() => {});
        }

        // Log to prediction_log for self-learning
        logPrediction({
          fixture_id:      id,
          league_id:       m.league?.id,
          league_name:     m.league?.name,
          home_team:       m.teams?.home?.name,
          away_team:       m.teams?.away?.name,
          minute:          currMin,
          score:           `${currHome}-${currAway}`,
          module:          alertType === 'HIGH_NGP' ? 'NGP' : 'OVER15',
          predicted_value: alertType === 'HIGH_NGP' ? ng : mk.over15,
          threshold_used:  70,
          ngp_value:       ng,
          lambda_home:     null,
          lambda_away:     null,
        }).catch(() => {});
        } // end else (_full — semnal real de bani)
      }
    }

    // ── PRUNE-BY-ABSENCE: meci dispărut din live=all (nu mai e „văzut") ──────
    // Când API scoate un meci din live=all fără FT prins, lastSeen se învechește.
    // Îl scoatem din liveCache + snap + freeze-state. Pragul 90s evită blip-urile.
    // NOTĂ: meciurile ÎNGHEȚATE (minut blocat dar încă trimise de API) NU se mai
    // ȘTERG aici — sunt FILTRATE la ieșire (vezi mai jos + football.js), ca să nu
    // intre în bucla delete/re-add. Starea _frozenSince persistă între scan-uri.
    {
      const nowPrune = Date.now();
      for (const id of Object.keys(liveCache)) {
        const lc = liveCache[id];
        if (nowPrune - (lc.lastSeen || 0) > LIVE_PRUNE_MS) {
          delete liveCache[id];
          delete _lastBroadcastSnap[id];
          clearFreeze(id);
        }
      }
    }

    // ── Rezolvare WIN/LOSS pentru contorul NGP — mn6 ────────────────────────
    resolveNGPOutcomes(raw).catch(e => log(`resolveNGPOutcomes: ${e.message}`));

    // ── FILTRARE FROZEN-DEAD la IEȘIRE (cheia fix-ului) ─────────────────────
    // Ascundem meciurile cu minut înghețat din lista trimisă către frontend, FĂRĂ
    // a le șterge din cache → rămân ascunse permanent cât timp API le retrimite
    // blocate. Auto-unfreeze: dacă elapsed crește, trackElapsed resetează _frozenSince
    // → isFrozenDead devine false → meciul reapare singur.
    const visibleMatches = processedMatches.filter(m => {
      const fid = m.fixture?.id;
      const st  = m.fixture?.status?.short || '';
      if (!fid) return true;
      const kickoffMs  = Date.parse(m.fixture?.date);
      const elapsedMin = m.fixture?.status?.elapsed;
      const reason = freezeReason(fid, st, kickoffMs, elapsedMin);
      if (reason) {
        maybeLogFrozen(fid, m.teams?.home?.name, elapsedMin, reason);
        return false;   // frozen → ascuns din lista live
      }
      return true;
    });

    // ── Delta broadcast — full la fiecare 5min, delta când sunt schimbări ────
    if (typeof global.wsBroadcast === 'function') {
      const now = Date.now();
      const isFullUpdate = !global._lastFullBroadcast ||
                           (now - global._lastFullBroadcast) > 5 * 60 * 1000;

      const changedMatches = visibleMatches.filter(m => {
        const fid = m.fixture?.id;
        if (!fid) return false;
        const snap = [m.goals?.home, m.goals?.away,
                      m.fixture?.status?.elapsed, m.fixture?.status?.short].join('|');
        if (_lastBroadcastSnap[fid] === snap) return false;
        _lastBroadcastSnap[fid] = snap;
        return true;
      });

      // Curăță snap-uri pentru meciuri terminate / ascunse (frozen) → la unfreeze
      // reapar ca „changed" și se rebroadcast.
      const activeIds = new Set(visibleMatches.map(m => m.fixture?.id).filter(Boolean));
      Object.keys(_lastBroadcastSnap).forEach(id => {
        if (!activeIds.has(Number(id))) delete _lastBroadcastSnap[id];
      });

      // [P02] REMOVAL: orice meci care era în lista live ciclul trecut și acum a ieșit
      // (FT/AET/PEN, terminal-extra, frozen sau prune-by-absence) → semnal de eliminare
      // către UI, cu scorul final unde îl cunoaștem.
      const prevIds = (global._prevLiveIds instanceof Set) ? global._prevLiveIds : new Set();
      const removed = [];
      prevIds.forEach(id => {
        if (!activeIds.has(id)) removed.push({ id, final: finishedThisCycle[id] || null });
      });
      global._prevLiveIds = activeIds;

      const liveData = { matches: visibleMatches, removed, ts: now };
      global.lastLiveData = liveData;

      if (isFullUpdate) {
        global._lastFullBroadcast = now;
        global.wsBroadcast('LIVE_UPDATE', liveData);
      } else if (changedMatches.length > 0 || removed.length > 0) {
        global.wsBroadcast('LIVE_DELTA', { changed: changedMatches, removed, ts: now });
      }
    }

    persistFreezeState();   // [P03] salvare throttled (30s) a stării de îngheț
  } catch (e) {
    log(`scanLive10s error: ${e.message}`);
  }
}

// ── Ciclu 2: /fixtures/{id}/statistics — la fiecare 60 secunde ───────────────

async function scanLiveStats() {
  if (!FOOTBALL_KEY) return;
  const activeIds = Object.keys(liveCache);
  if (!activeIds.length) return;
  log(`liveStats: ${activeIds.length} active matches`);

  // FIX 3: paralelizare în batches de 5 concurent (era forEach + await
  // secvențial — ~200ms × N latency). Reducere ~4× pe 20 meciuri.
  async function processOne(id) {
    try {
      const stats = await fetchWithRetry(`/fixtures/statistics?fixture=${id}`);
      if (!stats.length || !liveCache[id]) return;
      const cached = liveCache[id];
      const fakeMatch = {
        fixture:    { id: Number(id), status: { elapsed: cached.minute } },
        goals:      { home: cached.home_goals, away: cached.away_goals },
        statistics: stats,
      };
      const f = calcFeatures(fakeMatch, cached.formData || {});
      saveLiveStats(fakeMatch, f, cached.status)
        .catch(e => log(`saveLiveStats ${id}: ${e.message}`));
    } catch (e) {
      log(`liveStats error ${id}: ${e.message}`);
    }
  }

  const BATCH = 5;
  for (let i = 0; i < activeIds.length; i += BATCH) {
    const slice = activeIds.slice(i, i + BATCH);
    await Promise.all(slice.map(processOne));
  }
}

// ── Ciclu 3: pre-meci — citire din prematch_data la fiecare 60 minute ─────────
// Datele sunt populate de /api/cron/prematch-enrichment (cron */5 * * * *).

async function scanPreMatch() {
  try {
    const nowMs = Date.now();
    const in24h = new Date(nowMs + 86_400_000).toISOString();

    const fxR = await query(
      `SELECT fixture_id AS id FROM fixtures
       WHERE status_short='NS' AND match_date >= $1 AND match_date <= $2
       ORDER BY match_date ASC`,
      [new Date(nowMs).toISOString(), in24h]
    );

    const rows = fxR.rows;
    log(`preMatch: syncing cache for ${rows.length} fixtures from prematch_data`);
    let updated = 0;

    for (const fx of rows) {
      const cached = prematchCache[fx.id];
      if (cached && (nowMs - cached.ts) < 3_600_000) continue;

      try {
        const dataR = await query(
          `SELECT DISTINCT ON (data_type) data_type, payload
           FROM prematch_data WHERE fixture_id=$1
           ORDER BY data_type, stage DESC, collected_at DESC`,
          [fx.id]
        );
        const dm    = Object.fromEntries(dataR.rows.map(r => [r.data_type, r.payload]));
        const h2h   = Array.isArray(dm.h2h)       ? dm.h2h       : [];
        const hForm = Array.isArray(dm.home_form)  ? dm.home_form  : [];
        const aForm = Array.isArray(dm.away_form)  ? dm.away_form  : [];

        let composite = null;
        if (h2h.length >= 3 && hForm.length >= 3 && aForm.length >= 3) {
          const h2hN   = h2h.length;
          const ggH2H  = h2h.filter(g => g.goals?.home > 0 && g.goals?.away > 0).length / h2hN;
          const o15H2H = h2h.filter(g => (g.goals?.home || 0) + (g.goals?.away || 0) >= 2).length / h2hN;
          const hf5    = hForm.slice(0, 5);
          const af5    = aForm.slice(0, 5);
          const ggHF   = hf5.filter(g => (g.goals?.home || 0) > 0 || (g.goals?.away || 0) > 0).length / hf5.length;
          const ggAF   = af5.filter(g => (g.goals?.home || 0) > 0 || (g.goals?.away || 0) > 0).length / af5.length;
          const o15HF  = hf5.reduce((s, g) => s + (g.goals?.home || 0) + (g.goals?.away || 0), 0) / hf5.length;
          const o15AF  = af5.reduce((s, g) => s + (g.goals?.home || 0) + (g.goals?.away || 0), 0) / af5.length;
          const ggScore  = ggH2H * 0.30 + ggHF * 0.25 + ggAF * 0.25 + o15H2H * 0.20;
          const o15Score = o15H2H * 0.30 + (o15HF / 3) * 0.25 + (o15AF / 3) * 0.25 + ggH2H * 0.20;
          composite = Math.round((ggScore + o15Score) / 2 * 100);
        }

        prematchCache[fx.id] = { ts: nowMs, composite };
        updated++;
      } catch (_) {}
    }

    log(`preMatch done: ${updated} updated, cache size ${Object.keys(prematchCache).length}`);
  } catch (e) {
    log(`scanPreMatch error: ${e.message}`);
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

async function ensureTables() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS match_snapshots (
        fixture_id    INTEGER PRIMARY KEY,
        league_id     INTEGER,
        home_team     TEXT,
        away_team     TEXT,
        status_short  TEXT,
        minute        INTEGER,
        home_goals    INTEGER DEFAULT 0,
        away_goals    INTEGER DEFAULT 0,
        ng            INTEGER,
        over15        INTEGER,
        outcome       TEXT DEFAULT 'LIVE',
        composite_score NUMERIC(5,2),
        final_home    INTEGER,
        final_away    INTEGER,
        resolved_at   TIMESTAMP,
        created_at    TIMESTAMP DEFAULT NOW(),
        updated_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    log('ensureTables: match_snapshots OK');
  } catch (e) {
    log(`ensureTables error: ${e.message}`);
  }
}

// Flag pauza scanner (accesibil din admin endpoint)
let scannerPaused = false;
export function getScannerPaused() { return scannerPaused; }
export function setScannerPaused(v) {
  scannerPaused = !!v;
  console.log(`[scanner] ${scannerPaused ? '⏸ PAUSED' : '▶ RESUMED'} via admin`);
  return scannerPaused;
}

export function startScanner() {
  if (!FOOTBALL_KEY) {
    console.log('[scanner] No FOOTBALL_API_KEY — scanner disabled');
    return;
  }

  ensureTables();
  loadFreezeState();   // [P03] reîncarcă starea de îngheț salvată → restart-proof

  // Wrappers care respecta scannerPaused
  function runIfActive(fn, name) {
    return async function() {
      if (scannerPaused) return;
      try { await fn(); } catch (e) { console.error(`[scanner/${name}]`, e.message); }
    };
  }

  // Rulare imediată la startup
  runIfActive(scanLive10s, 'live10s')();
  runIfActive(scanPreMatch, 'preMatch')();

  // FIX 1: scanLive10s la 2s (paritate sub-FlashScore, ~5s la ei).
  //        Cost: 1 call/2s = 1800/h = 43.2k/zi pentru /live=all.
  // FIX 2: scanLiveStats la 10s (statistici xG/pose/SOT mai proaspete).
  //        Cost: ~20 meciuri × 6 calls/min × 60 min × 24h ≈ 173k/zi.
  //        Total scanner ~216k/zi din 300k (72%) — sustenabil.
  setInterval(runIfActive(scanLive10s,    'live10s'),     2_000);
  setInterval(runIfActive(scanLiveStats,  'liveStats'),  10_000);
  setInterval(runIfActive(scanPreMatch,   'preMatch'),  3_600_000);

  console.log('[scanner] Started — live/10s, stats/60s, prematch/1h');
}
