// Vercel Cron Job — runs every minute
// Fetches live matches, calculates NGP/markets, stores snapshots in PostgreSQL

import { query } from '../db.js';
import { calcFeatures, calcNextGoal, calcGG, calcMarkets } from '../utils/live-score.js';

const FOOTBALL_KEY = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;

const LIVE_STATUS = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT']);
const DONE_STATUS = new Set(['FT', 'AET', 'PEN']);

// --- PostgreSQL helpers ---

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

async function saveFormStats(matches, teamId) {
  // form_stats schema uses UNIQUE(team_id, league_id, season) with aggregate columns,
  // not per-match rows — skip silently
  return;
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

let _runCount = 0;

function log(msg) {
  console.log(`[cron/scan] ${new Date().toISOString()} ${msg}`);
}

export default async function handler(req, res) {
  if (CRON_SECRET) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!FOOTBALL_KEY) {
    log('ERROR: no FOOTBALL_API_KEY');
    return res.status(200).json({ error: 'No API key' });
  }

  _runCount++;
  log(`run #${_runCount}`);

  let liveMatches = [], finishedMatches = [];
  try {
    const liveR = await fetch('https://v3.football.api-sports.io/fixtures?live=all', {
      headers: { 'x-apisports-key': FOOTBALL_KEY }
    });
    const liveData = await liveR.json();
    const raw = Array.isArray(liveData.response) ? liveData.response : [];
    log(`api-football live: ${raw.length}`);

    for (const m of raw) {
      const sh = m.fixture?.status?.short || '';
      if (LIVE_STATUS.has(sh)) liveMatches.push(m);
    }
  } catch (e) {
    log(`fetch live error: ${e.message}`);
  }

  try {
    const now = new Date();
    const from = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString().slice(0, 16);
    const to   = now.toISOString().slice(0, 16);
    const r = await fetch(
      `https://v3.football.api-sports.io/fixtures?status=FT-AET-PEN&from=${from.slice(0,10)}&to=${to.slice(0,10)}`,
      { headers: { 'x-apisports-key': FOOTBALL_KEY } }
    );
    const data = await r.json();
    finishedMatches = Array.isArray(data.response) ? data.response : [];
    log(`api-football finished: ${finishedMatches.length}`);
  } catch (e) {
    log(`fetch finished error: ${e.message}`);
  }

  const snapshotResults = [];
  for (const m of liveMatches) {
    try {
      const sh      = m.fixture?.status?.short || '';
      const elapsed = m.fixture?.status?.elapsed ?? 0;
      const f       = calcFeatures(m);
      const ng      = calcNextGoal(f);
      const mk      = calcMarkets(f);

      await upsertSnapshot({
        fixture_id: m.fixture.id, league_id: m.league?.id,
        home_team: m.teams?.home?.name, away_team: m.teams?.away?.name,
        status_short: sh, minute: elapsed,
        home_goals: m.goals?.home ?? 0, away_goals: m.goals?.away ?? 0,
        ng, over15: mk.over15, outcome: 'LIVE',
      });
      snapshotResults.push({ id: m.fixture.id, ng, status: sh, minute: elapsed });

      // Save live_stats (non-blocking)
      saveLiveStats(m, f, sh).catch(e => log(`live_stats error ${m.fixture.id}: ${e.message}`));

      // Save alert once per match when NGP > 70 or over15 > 70
      if (ng > 70 || mk.over15 > 70) {
        const alertType = ng > 70 ? 'HIGH_NGP' : 'HIGH_OVER15';
        const market    = ng > 70 ? 'ng' : 'over15';
        const conf      = ng > 70 ? ng / 100 : mk.over15 / 100;
        const msg       = `${m.teams?.home?.name} vs ${m.teams?.away?.name} — ${alertType} ${Math.round(conf * 100)}% min ${elapsed}`;
        saveAlert(m.fixture.id, alertType, market, msg, conf)
          .catch(e => log(`alert error ${m.fixture.id}: ${e.message}`));
      }
    } catch (e) {
      log(`snapshot error fixture ${m.fixture?.id}: ${e.message}`);
    }
  }

  const resolved = [];
  for (const m of finishedMatches) {
    try {
      const fh = m.goals?.home ?? 0;
      const fa = m.goals?.away ?? 0;
      const outcome = (fh + fa) >= 2 ? 'WIN' : 'LOSS';
      await resolveOutcome(m.fixture.id, outcome, fh, fa);
      resolved.push({ id: m.fixture.id, outcome, score: `${fh}-${fa}` });
    } catch (e) {
      log(`resolve error fixture ${m.fixture?.id}: ${e.message}`);
    }
  }

  // Salvează h2h pentru meciurile FT (funcție orfană înainte, acum wired up)
  // Permite Generator-ului să folosească date h2h reale în calculul GG.
  if (finishedMatches.length > 0) {
    try {
      await saveH2H(finishedMatches);
      log(`h2h: ${finishedMatches.length} meciuri salvate`);
    } catch (e) {
      log(`saveH2H error: ${e.message}`);
    }
  }

  // Pre-match — citire din prematch_data (populat de /api/cron/prematch-enrichment)
  const pmResults = [];
  try {
    const nowMs = Date.now();
    const in24h = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();

    const fxR = await query(
      `SELECT fixture_id AS id FROM fixtures
       WHERE status_short='NS' AND match_date >= $1 AND match_date <= $2
       ORDER BY match_date ASC`,
      [new Date(nowMs).toISOString(), in24h]
    );

    for (const fx of fxR.rows) {
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
        if (h2h.length < 3 || hForm.length < 3 || aForm.length < 3) continue;

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
        pmResults.push({ id: fx.id, composite: Math.round((ggScore + o15Score) / 2 * 100) });
      } catch (e) {
        log(`pm read error ${fx.id}: ${e.message}`);
      }
    }
  } catch (e) {
    log(`pre-match scan error: ${e.message}`);
  }

  // Curăță snapshot-uri LIVE mai vechi de 6 ore (meciuri terminate fără resolveOutcome)
  query(
    `UPDATE match_snapshots SET outcome='STALE'
     WHERE outcome='LIVE' AND created_at < NOW() - INTERVAL '6 hours'`
  ).catch(() => {});

  log(`done: ${snapshotResults.length} snapshots, ${resolved.length} resolved, ${pmResults.length} pre-match`);

  query(
    `INSERT INTO cron_logs (job_name, fixtures_processed, status)
     VALUES ($1,$2,'success')`,
    ['scan', snapshotResults.length + resolved.length]
  ).catch(() => {});

  return res.status(200).json({
    run: _runCount,
    snapshots: snapshotResults.length,
    resolved: resolved.length,
    prematch: pmResults.length,
    live: snapshotResults,
    outcomes: resolved,
    prematch_list: pmResults,
  });
}
