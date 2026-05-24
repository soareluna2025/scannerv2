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
import { calcFeatures, calcNextGoal, calcGG, calcMarkets } from '../utils/live-score.js';

const FOOTBALL_KEY = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;

const LIVE_STATUS = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT']);
const DONE_STATUS = new Set(['FT', 'AET', 'PEN']);

// Stare în memorie
const liveCache         = {}; // { [fixtureId]: { home_goals, away_goals, status, minute, lineupsFetched } }
const prematchCache     = {}; // { [fixtureId]: { ts, composite } }
const _lastBroadcastSnap = {}; // { [fixtureId]: snap string } — pentru delta updates

let _patternRunCount = 0;
let _scanCounter = 0;

function getMatchPriority(m) {
  const sh  = m.fixture?.status?.short || '';
  const mn  = m.fixture?.status?.elapsed ?? 0;
  const hg  = m.goals?.home ?? 0;
  const ag  = m.goals?.away ?? 0;
  if (DONE_STATUS.has(sh) || sh === 'HT') return 'low';
  if (mn >= 75 || (hg + ag === 0 && mn >= 60)) return 'high';
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

async function upsertSnapshot(row) {
  await query(
    `INSERT INTO match_snapshots
       (fixture_id, league_id, home_team, away_team,
        status_short, minute, home_goals, away_goals,
        ng, over15, outcome)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (fixture_id) DO UPDATE SET
       status_short=EXCLUDED.status_short,
       minute=EXCLUDED.minute,
       home_goals=EXCLUDED.home_goals,
       away_goals=EXCLUDED.away_goals,
       ng=EXCLUDED.ng,
       over15=EXCLUDED.over15,
       outcome=EXCLUDED.outcome`,
    [
      row.fixture_id, row.league_id, row.home_team, row.away_team,
      row.status_short, row.minute, row.home_goals, row.away_goals,
      row.ng, row.over15, row.outcome || 'LIVE',
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

async function leagueSnapshots(leagueId, limit = 200) {
  try {
    const r = leagueId
      ? await query(
          `SELECT * FROM match_snapshots
           WHERE league_id=$1 AND outcome != 'LIVE'
           ORDER BY created_at DESC LIMIT $2`,
          [leagueId, limit])
      : await query(
          `SELECT * FROM match_snapshots
           WHERE outcome != 'LIVE'
           ORDER BY created_at DESC LIMIT $1`,
          [limit]);
    return r.rows;
  } catch (_) { return []; }
}

async function upsertLeaguePattern(row) {
  await query(
    `INSERT INTO league_patterns
       (league_id, sample_size, avg_ng, avg_over15, updated_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (league_id) DO UPDATE SET
       sample_size=EXCLUDED.sample_size,
       avg_ng=EXCLUDED.avg_ng,
       avg_over15=EXCLUDED.avg_over15,
       updated_at=NOW()`,
    [row.league_id, row.sample_size, row.avg_ng, row.avg_over15]
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
    await query(`
      INSERT INTO fixtures_history
        (fixture_id, league_id, season,
         home_team_id, home_team_name, away_team_id, away_team_name,
         home_goals, away_goals, status_short, match_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'FT',$10)
      ON CONFLICT (fixture_id) DO UPDATE SET
        home_goals=EXCLUDED.home_goals, away_goals=EXCLUDED.away_goals, status_short='FT'
    `, [fid, lid, season, hid, m.teams?.home?.name || '', aid, m.teams?.away?.name || '', hg, ag, dt]);

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
  await query(
    `INSERT INTO live_stats
       (fixture_id, elapsed, home_goals, away_goals,
        home_sot, away_sot, home_shots, away_shots,
        home_possession, away_possession,
        home_corners, away_corners,
        home_da, away_da,
        home_xg, away_xg)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
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
    ]
  );
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

// ── Ciclu 1: /fixtures?live=all — la fiecare 10 secunde ──────────────────────

async function scanLive10s() {
  if (!FOOTBALL_KEY) return;
  _scanCounter++;
  try {
    const rawAll = await fetchWithRetry('/fixtures?live=all');
    const raw = rawAll.filter(m => isAllowedMatch(m, ALLOWED_LEAGUE_IDS));
    log(`live10s: ${rawAll.length} din API → ${raw.length} după filtrare`);

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

    for (const m of raw) {
      const sh = m.fixture?.status?.short || '';
      const id = m.fixture?.id;
      if (!id) continue;

      // Meci terminat — rezolvă outcome dacă îl urmăream
      if (DONE_STATUS.has(sh)) {
        if (liveCache[id]) {
          const fh = m.goals?.home ?? 0;
          const fa = m.goals?.away ?? 0;
          resolveOutcome(id, (fh + fa) >= 2 ? 'WIN' : 'LOSS', fh, fa)
            .catch(e => log(`resolveOutcome ${id}: ${e.message}`));
          saveFormStats(m).catch(e => log(`saveFormStats ${id}: ${e.message}`)); // M5
          delete liveCache[id];
        }
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
      const f  = calcFeatures(m, matchFd[id] || {});
      const ng = calcNextGoal(f);
      const mk = calcMarkets(f);

      upsertSnapshot({
        fixture_id:   id,            league_id:  m.league?.id,
        home_team:    m.teams?.home?.name,       away_team: m.teams?.away?.name,
        status_short: sh,            minute:     currMin,
        home_goals:   currHome,      away_goals: currAway,
        ng,           over15: mk.over15,         outcome: 'LIVE',
      }).catch(e => log(`upsertSnapshot ${id}: ${e.message}`));

      processedMatches.push({ ...m, _ng: ng, _mk: mk });

      // Alerte — o singura data per meci cand NGP trece de 70%
      if (ng > 70 || mk.over15 > 70) {
        const alertType = ng > 70 ? 'HIGH_NGP' : 'HIGH_OVER15';
        const conf      = ng > 70 ? ng / 100 : mk.over15 / 100;
        const msg       = `${m.teams?.home?.name} vs ${m.teams?.away?.name} — ${alertType} ${Math.round(conf * 100)}% min ${currMin}`;
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
      }
    }

    // ── Rezolvare WIN/LOSS pentru contorul NGP — mn6 ────────────────────────
    resolveNGPOutcomes(raw).catch(e => log(`resolveNGPOutcomes: ${e.message}`));

    // League patterns la fiecare 10 rulări
    _patternRunCount++;
    if (_patternRunCount % 10 === 0) {
      leagueSnapshots(null, 1000).then(recent => {
        const byLeague = {};
        for (const s of recent) {
          if (!s.league_id) continue;
          if (!byLeague[s.league_id]) byLeague[s.league_id] = [];
          byLeague[s.league_id].push(s);
        }
        let count = 0;
        for (const [lid, snaps] of Object.entries(byLeague)) {
          const n          = snaps.length;
          const avg_ng     = Math.round(snaps.reduce((s, x) => s + (x.ng    || 0), 0) / n);
          const avg_over15 = Math.round(snaps.reduce((s, x) => s + (x.over15 || 0), 0) / n);
          upsertLeaguePattern({ league_id: Number(lid), sample_size: n, avg_ng, avg_over15 })
            .catch(() => {});
          count++;
        }
        log(`league patterns: ${count} updated`);
      }).catch(() => {});
    }

    // ── Delta broadcast — full la fiecare 5min, delta când sunt schimbări ────
    if (typeof global.wsBroadcast === 'function') {
      const now = Date.now();
      const isFullUpdate = !global._lastFullBroadcast ||
                           (now - global._lastFullBroadcast) > 5 * 60 * 1000;

      const changedMatches = processedMatches.filter(m => {
        const fid = m.fixture?.id;
        if (!fid) return false;
        const snap = [m.goals?.home, m.goals?.away,
                      m.fixture?.status?.elapsed, m.fixture?.status?.short].join('|');
        if (_lastBroadcastSnap[fid] === snap) return false;
        _lastBroadcastSnap[fid] = snap;
        return true;
      });

      // Curăță snap-uri pentru meciuri terminate
      const activeIds = new Set(processedMatches.map(m => m.fixture?.id));
      Object.keys(_lastBroadcastSnap).forEach(id => {
        if (!activeIds.has(Number(id))) delete _lastBroadcastSnap[id];
      });

      const liveData = { matches: processedMatches, ts: now };
      global.lastLiveData = liveData;

      if (isFullUpdate) {
        global._lastFullBroadcast = now;
        global.wsBroadcast('LIVE_UPDATE', liveData);
      } else if (changedMatches.length > 0) {
        global.wsBroadcast('LIVE_DELTA', { changed: changedMatches, ts: now });
      }
    }
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

  for (const id of activeIds) {
    try {
      const stats = await fetchWithRetry(`/fixtures/statistics?fixture=${id}`);
      if (!stats.length || !liveCache[id]) continue;

      const cached = liveCache[id];
      // Construiește obiect compatibil cu calcFeatures/saveLiveStats
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
    await query(`
      CREATE TABLE IF NOT EXISTS league_patterns (
        league_id   INTEGER PRIMARY KEY,
        sample_size INTEGER DEFAULT 0,
        avg_ng      NUMERIC(5,2),
        avg_over15  NUMERIC(5,2),
        avg_goals   NUMERIC(4,2),
        avg_cards   NUMERIC(4,2),
        avg_corners NUMERIC(4,2),
        over15_pct  NUMERIC(5,2),
        gg_pct      NUMERIC(5,2),
        updated_at  TIMESTAMP DEFAULT NOW()
      )
    `);
    log('ensureTables: match_snapshots + league_patterns OK');
  } catch (e) {
    log(`ensureTables error: ${e.message}`);
  }
}

export function startScanner() {
  if (!FOOTBALL_KEY) {
    console.log('[scanner] No FOOTBALL_API_KEY — scanner disabled');
    return;
  }

  ensureTables();

  // Rulare imediată la startup
  scanLive10s();
  scanPreMatch();

  setInterval(scanLive10s,    10_000);      // la fiecare 10s
  setInterval(scanLiveStats,  60_000);      // la fiecare 60s
  setInterval(scanPreMatch,  3_600_000);    // la fiecare 60min

  console.log('[scanner] Started — live/10s, stats/60s, prematch/1h');
}
