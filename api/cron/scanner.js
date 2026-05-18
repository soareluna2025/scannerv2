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

const FOOTBALL_KEY = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;

const LIVE_STATUS = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT']);
const DONE_STATUS = new Set(['FT', 'AET', 'PEN']);

// Stare în memorie
const liveCache     = {}; // { [fixtureId]: { home_goals, away_goals, status, minute, lineupsFetched } }
const prematchCache = {}; // { [fixtureId]: { ts, composite } }

let _patternRunCount = 0;

const formCache = {}; // { [key]: { ts, val } }
const FORM_CACHE_TTL = 3_600_000; // 1 hour

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

// ── Scoring — copiate verbatim din cron/scan.js ───────────────────────────────

function poissonProb(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 0; i < k; i++) p = p * lambda / (i + 1);
  return p;
}

function mkt(need, lambda) {
  if (need <= 0) return 100;
  let pFail = 0;
  for (let k = 0; k < need; k++) pFail += poissonProb(lambda, k);
  return Math.round(Math.max(5, Math.min(98, (1 - pFail) * 100)));
}

function getStat(stats, teamIdx, type) {
  const team = stats?.[teamIdx]?.statistics;
  if (!Array.isArray(team)) return 0;
  const entry = team.find(s => s.type === type);
  const v = entry?.value;
  if (v === null || v === undefined || v === 'N/A' || v === '') return 0;
  return parseFloat(v) || 0;
}

function calcFeatures(m, fd = {}) {
  const st  = m.statistics || [];
  const mn  = m.fixture?.status?.elapsed || 0;
  const hg  = m.goals?.home ?? 0;
  const ag  = m.goals?.away ?? 0;

  const hxg  = getStat(st, 0, 'expected_goals');
  const axg  = getStat(st, 1, 'expected_goals');
  const hSOT = getStat(st, 0, 'Shots on Goal');
  const aSOT = getStat(st, 1, 'Shots on Goal');
  const hSh  = getStat(st, 0, 'Shots off Goal') + hSOT;
  const aSh  = getStat(st, 1, 'Shots off Goal') + aSOT;
  const hp   = getStat(st, 0, 'Ball Possession') || 50;
  const hC   = getStat(st, 0, 'Corner Kicks');
  const aC   = getStat(st, 1, 'Corner Kicks');
  const hDA  = getStat(st, 0, 'Dangerous Attacks');
  const aDA  = getStat(st, 1, 'Dangerous Attacks');
  const hSv  = getStat(st, 0, 'Goalkeeper Saves');
  const aSv  = getStat(st, 1, 'Goalkeeper Saves');

  const txg  = hxg + axg;
  const tSh  = hSh + aSh;
  const tSOT = hSOT + aSOT;
  const tC   = hC + aC;
  const tDA  = hDA + aDA;

  return {
    hxg, axg, hSOT, aSOT, hSh, aSh, hp, hC, aC, hDA, aDA, hSv, aSv,
    txg, tSh, tSOT, tC, tDA, mn, hg, ag,
    xgTotal: Math.min(txg / 3, 1),
    hxgN: Math.min(hxg / 1.5, 1),
    axgN: Math.min(axg / 1.5, 1),
    shots: Math.min(tSh / 25, 1),
    corners: Math.min(tC / 15, 1),
    dangerousAttacks: tDA > 0 ? Math.min(tDA / 120, 1) : 0,
    timeProgress: Math.min(mn / 90, 1),
    isGoless: (hg + ag === 0) ? 1 : 0,
    homeFormGoals: fd.homeFormGoals ?? 0.35,
    awayFormGoals: fd.awayFormGoals ?? 0.35,
    homeFormGG:    fd.homeFormGG    ?? 0.45,
    awayFormGG:    fd.awayFormGG    ?? 0.45,
    h2hGoalRate:   fd.h2hGoalRate   ?? 0.35,
    h2hGGRate:     fd.h2hGGRate     ?? 0.45,
    xgSpike: 0, prsAcc: 0,
  };
}

function calcNextGoal(f) {
  const mn = f.mn || 0;
  const remFrac = Math.max(0, Math.min(1, (90 - mn) / 90));
  let remXg = mn > 0 ? (f.txg / mn) * (90 - mn) : 0.025 * (90 - mn);
  if (f.txg === 0) {
    remXg = ((f.homeFormGoals + f.awayFormGoals) / 2 * 2.5) * remFrac;
  }
  remXg += f.xgSpike * 0.3 + f.prsAcc * 0.2;
  if (mn >= 70) remXg *= 1.2;
  if (mn >= 80) remXg *= 1.15;
  const prob = 1 - Math.exp(-Math.max(remXg, 0.05));
  return Math.round(Math.max(3, Math.min(97, prob * 100)));
}

function calcGG(f) {
  const mn = f.mn || 0;
  const remFrac = Math.max(0, Math.min(1, (90 - mn) / 90));
  const histGG = (f.homeFormGG + f.awayFormGG) / 2 * 0.7 + f.h2hGGRate * 0.3;
  const hxgRate = mn > 0 ? (f.hxg / (mn / 90)) : f.hxg;
  const axgRate = mn > 0 ? (f.axg / (mn / 90)) : f.axg;
  const pScore = (lam, scored) => {
    if (scored > 0) return 1;
    return 1 - Math.exp(-Math.max(lam * remFrac, 0.05));
  };
  const hLam = Math.max(hxgRate > 0 ? hxgRate : f.homeFormGoals * 1.5, 0.3);
  const aLam = Math.max(axgRate > 0 ? axgRate : f.awayFormGoals * 1.5, 0.3);
  let ggPred = pScore(hLam, f.hg) * pScore(aLam, f.ag) * 0.6 + histGG * 0.4;
  if (f.hg === 0 && f.ag === 0 && mn >= 70) ggPred *= 0.75;
  if (f.hg === 0 && f.ag === 0 && mn >= 80) ggPred *= 0.65;
  return Math.round(Math.max(5, Math.min(95, ggPred * 100)));
}

function calcMarkets(f) {
  const mn     = f.mn || 0;
  const totalG = f.hg + f.ag;
  const remFrac = Math.max(0, Math.min(1, (95 - mn) / 90));
  const lxg   = f.xgTotal > 0 ? f.txg * 3 : 0;
  const lform  = ((f.homeFormGoals + f.awayFormGoals) / 2) * 3;
  const lh2h   = f.h2hGoalRate * 3;
  let lb = lxg > 0 ? lxg * 0.55 + lform * 0.25 + lh2h * 0.2
                   : lform * 0.55 + lh2h * 0.45;
  if (lb < 0.8) lb = 1.6;
  const lr = lb * remFrac + f.xgSpike * 0.3 + f.prsAcc * 0.2;

  const lhf = f.homeFormGoals * 1.5;
  const laf = f.awayFormGoals * 1.5;
  const lhb = Math.max(f.hxgN > 0 ? f.hxgN * 1.5 * 0.6 + lhf * 0.4 : lhf, 0.3);
  const lab = Math.max(f.axgN > 0 ? f.axgN * 1.5 * 0.6 + laf * 0.4 : laf, 0.3);
  const lhr = lhb * remFrac + f.xgSpike * 0.1;
  const lar = lab * remFrac + f.prsAcc * 0.1;

  return {
    over05: mkt(Math.max(0, 1 - totalG), lr),
    over15: mkt(Math.max(0, 2 - totalG), lr),
    over25: mkt(Math.max(0, 3 - totalG), lr),
    gg:     calcGG(f),
    home05: mkt(Math.max(0, 1 - f.hg), lhr),
    home15: mkt(Math.max(0, 2 - f.hg), lhr),
    away05: mkt(Math.max(0, 1 - f.ag), lar),
    away15: mkt(Math.max(0, 2 - f.ag), lar),
  };
}

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

async function saveH2H(matches) {
  for (const match of matches) {
    const hg  = match.goals?.home ?? 0;
    const ag  = match.goals?.away ?? 0;
    const hid = match.teams?.home?.id;
    const aid = match.teams?.away?.id;
    if (!hid || !aid) continue;
    await query(
      `INSERT INTO h2h
         (team1_id, team2_id, fixture_id, home_team_id, away_team_id,
          match_date, home_goals, away_goals, league_id, season)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (team1_id, team2_id, fixture_id) DO UPDATE SET
         home_goals=EXCLUDED.home_goals, away_goals=EXCLUDED.away_goals`,
      [
        Math.min(hid, aid), Math.max(hid, aid),
        match.fixture.id, hid, aid,
        match.fixture?.date || null,
        hg, ag,
        match.league?.id || null,
        new Date().getFullYear(),
      ]
    );
  }
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

// ── Ciclu 1: /fixtures?live=all — la fiecare 10 secunde ──────────────────────

async function scanLive10s() {
  if (!FOOTBALL_KEY) return;
  try {
    const raw = await apiFetch('/fixtures?live=all');
    log(`live10s: ${raw.length} matches from API`);

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
          delete liveCache[id];
        }
        continue;
      }

      if (!LIVE_STATUS.has(sh)) continue;

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
        apiFetch(`/fixtures/lineups?fixture=${id}`)
          .then(lineups => { if (liveCache[id]) liveCache[id].lineups = lineups; })
          .catch(() => {});
      } else {
        // Scorul s-a schimbat — fetch events imediat
        if (prev.home_goals !== currHome || prev.away_goals !== currAway) {
          log(`score change ${id}: ${currHome}-${currAway}`);
          apiFetch(`/fixtures/events?fixture=${id}`)
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

    // ── Rezolvare WIN/LOSS pentru contorul NGP din header ────────────────────
    const liveFixtureIds = raw
      .filter(m => LIVE_STATUS.has(m.fixture?.status?.short || ''))
      .map(m => m.fixture?.id)
      .filter(Boolean);

    // WIN: meci încă live dar scorul s-a schimbat față de score_at_alert
    // Detectăm prin liveCache[id].ngpAlertScore vs scorul curent
    const winIds = [];
    for (const m of raw) {
      const mid = m.fixture?.id;
      if (!mid || !LIVE_STATUS.has(m.fixture?.status?.short || '')) continue;
      const cached = liveCache[mid];
      if (cached?.ngpAlertScore) {
        const curScore = `${m.goals?.home ?? 0}-${m.goals?.away ?? 0}`;
        if (curScore !== cached.ngpAlertScore) {
          winIds.push(mid);
          cached.ngpAlertScore = null; // marcat — nu mai trimitem WIN repetat
        }
      }
    }
    if (winIds.length > 0) {
      query(
        `UPDATE predictions SET outcome_ngp='WIN', updated_at=NOW()
         WHERE outcome_ngp='PENDING' AND fixture_id = ANY($1) AND score_at_alert IS NOT NULL`,
        [winIds]
      ).catch(() => {});
    }

    // LOSS: predicție PENDING dar meciul nu mai e live
    if (liveFixtureIds.length > 0) {
      query(
        `UPDATE predictions SET outcome_ngp='LOSS', updated_at=NOW()
         WHERE outcome_ngp='PENDING'
           AND score_at_alert IS NOT NULL
           AND match_date > NOW() - INTERVAL '3h'
           AND fixture_id != ALL($1::int[])`,
        [liveFixtureIds]
      ).catch(() => {});
    } else if (raw.length > 0) {
      // API a returnat date dar nu există meciuri live — rezolvă toate pending
      query(
        `UPDATE predictions SET outcome_ngp='LOSS', updated_at=NOW()
         WHERE outcome_ngp='PENDING'
           AND score_at_alert IS NOT NULL
           AND match_date > NOW() - INTERVAL '3h'`
      ).catch(() => {});
    }

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
      const stats = await apiFetch(`/fixtures/statistics?fixture=${id}`);
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

export function startScanner() {
  if (!FOOTBALL_KEY) {
    console.log('[scanner] No FOOTBALL_API_KEY — scanner disabled');
    return;
  }

  // Rulare imediată la startup
  scanLive10s();
  scanPreMatch();

  setInterval(scanLive10s,    10_000);      // la fiecare 10s
  setInterval(scanLiveStats,  60_000);      // la fiecare 60s
  setInterval(scanPreMatch,  3_600_000);    // la fiecare 60min

  console.log('[scanner] Started — live/10s, stats/60s, prematch/1h');
}
