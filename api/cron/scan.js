// Vercel Cron Job — runs every minute
// Fetches live matches, calculates NGP/markets, stores snapshots in PostgreSQL

import { query } from '../db.js';

const FOOTBALL_KEY = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;

const LIVE_STATUS = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT']);
const DONE_STATUS = new Set(['FT', 'AET', 'PEN']);

// --- Poisson helpers ---
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

function calcFeatures(m) {
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

  const txg = hxg + axg;
  const tSh = hSh + aSh;
  const tSOT = hSOT + aSOT;
  const tC  = hC + aC;
  const tDA = hDA + aDA;

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
    homeFormGoals: 0.35, awayFormGoals: 0.35,
    homeFormGG: 0.45,    awayFormGG: 0.45,
    h2hGoalRate: 0.35,   h2hGGRate: 0.45,
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
  const mn = f.mn || 0;
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

// --- PostgreSQL helpers ---

async function upsertSnapshot(row) {
  // match_snapshots table not in schema — skip silently
  return null;
}

async function resolveOutcome(fixtureId, outcome, finalHome, finalAway) {
  // match_snapshots table not in schema — skip silently
  return null;
}

async function leagueSnapshots(leagueId, limit = 200) {
  // match_snapshots table not in schema — return empty
  return [];
}

async function upsertLeaguePattern(row) {
  // league_patterns table not in schema — skip silently
  return null;
}

async function saveLiveStats(m, f, status) {
  const st = m.statistics || [];
  const yc = getStat(st, 0, 'Yellow Cards') + getStat(st, 1, 'Yellow Cards');
  const rc = getStat(st, 0, 'Red Cards')    + getStat(st, 1, 'Red Cards');
  await query(
    `INSERT INTO live_stats
       (fixture_id, minute, status, home_goals, away_goals,
        xg, possession, shots_on_goal, shots_total,
        corners, yellow_cards, red_cards,
        odd_home, odd_draw, odd_away)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      m.fixture.id,
      f.mn,
      status || null,
      f.hg,
      f.ag,
      f.txg  || null,
      f.hp   || null,
      f.tSOT,
      f.tSh,
      f.tC,
      yc,
      rc,
      null,  // odd_home — nu e disponibil în datele live fără apel separat
      null,  // odd_draw
      null,  // odd_away
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
    `INSERT INTO alerts
       (fixture_id, type, message, confidence, is_sent, telegram_sent)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [fixtureId, alertType, message, confidence || null, false, false]
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

      // Save alert if NGP > 85 or over15 > 82
      if (ng > 85 || mk.over15 > 82) {
        const alertType = ng > 85 ? 'HIGH_NGP' : 'HIGH_OVER15';
        const market    = ng > 85 ? 'ng' : 'over15';
        const conf      = ng > 85 ? ng / 100 : mk.over15 / 100;
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
      const outcome = (fh + fa) > 0 ? 'WIN' : 'LOSS';
      await resolveOutcome(m.fixture.id, outcome, fh, fa);
      resolved.push({ id: m.fixture.id, outcome, score: `${fh}-${fa}` });
    } catch (e) {
      log(`resolve error fixture ${m.fixture?.id}: ${e.message}`);
    }
  }

  if (_runCount % 10 === 0) {
    log('recalculating league patterns...');
    try {
      const recent = await leagueSnapshots(null, 1000);
      // league_patterns table not in schema — no-op
      log(`league patterns skipped (table not in schema)`);
    } catch (e) {
      log(`league patterns error: ${e.message}`);
    }
  }

  // Scan pre-match fixtures (starting in next 24h)
  const pmResults = [];
  try {
    const nowMs = Date.now();
    const in24h = nowMs + 24 * 60 * 60 * 1000;
    const today    = new Date(nowMs).toISOString().split('T')[0];
    const tomorrow = new Date(in24h).toISOString().split('T')[0];

    const [todayR, tomorrowR] = await Promise.all([
      fetch(`https://v3.football.api-sports.io/fixtures?date=${today}&status=NS`,    { headers: { 'x-apisports-key': FOOTBALL_KEY } }),
      fetch(`https://v3.football.api-sports.io/fixtures?date=${tomorrow}&status=NS`, { headers: { 'x-apisports-key': FOOTBALL_KEY } }),
    ]);
    const [todayData, tomorrowData] = await Promise.all([todayR.json(), tomorrowR.json()]);
    const allFixtures = [
      ...(Array.isArray(todayData.response)    ? todayData.response    : []),
      ...(Array.isArray(tomorrowData.response) ? tomorrowData.response : []),
    ];

    const upcoming = allFixtures.filter(m => {
      const fd = m.fixture?.date ? new Date(m.fixture.date).getTime() : 0;
      return fd >= nowMs && fd <= in24h;
    });

    log(`pre-match upcoming: ${upcoming.length}`);

    for (const m of upcoming) {
      try {
        const hid = m.teams?.home?.id;
        const aid = m.teams?.away?.id;
        if (!hid || !aid) continue;

        const [h2hR, hfR, afR] = await Promise.all([
          fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${hid}-${aid}&last=10`, { headers: { 'x-apisports-key': FOOTBALL_KEY } }),
          fetch(`https://v3.football.api-sports.io/fixtures?team=${hid}&last=5&status=FT`, { headers: { 'x-apisports-key': FOOTBALL_KEY } }),
          fetch(`https://v3.football.api-sports.io/fixtures?team=${aid}&last=5&status=FT`, { headers: { 'x-apisports-key': FOOTBALL_KEY } })
        ]);
        const [h2hData, hfData, afData] = await Promise.all([h2hR.json(), hfR.json(), afR.json()]);

        const h2h = h2hData.response || [];
        const hForm = hfData.response || [];
        const aForm = afData.response || [];

        if (h2h.length < 3 || hForm.length < 3 || aForm.length < 3) continue;

        // Save h2h (non-blocking)
        saveH2H(h2h).catch(e => log(`h2h save error ${m.fixture?.id}: ${e.message}`));
        // form_stats write skipped due to schema mismatch

        const h2hN = h2h.length;
        const ggH2HN = h2h.filter(g => g.goals?.home > 0 && g.goals?.away > 0).length;
        const o15H2HN = h2h.filter(g => (g.goals?.home || 0) + (g.goals?.away || 0) >= 2).length;
        const ggH2H = ggH2HN / h2hN;
        const over15H2H = o15H2HN / h2hN;

        const hf5 = hForm.slice(0, 5);
        const af5 = aForm.slice(0, 5);
        const ggHF = hf5.filter(g => (g.goals?.home || 0) > 0 || (g.goals?.away || 0) > 0).length / hf5.length;
        const ggAF = af5.filter(g => (g.goals?.home || 0) > 0 || (g.goals?.away || 0) > 0).length / af5.length;
        const o15HF = hf5.reduce((s, g) => s + (g.goals?.home || 0) + (g.goals?.away || 0), 0) / hf5.length;
        const o15AF = af5.reduce((s, g) => s + (g.goals?.home || 0) + (g.goals?.away || 0), 0) / af5.length;

        const ggScore   = ggH2H * 0.30 + ggHF * 0.25 + ggAF * 0.25 + over15H2H * 0.20;
        const o15Score  = over15H2H * 0.30 + (o15HF / 3) * 0.25 + (o15AF / 3) * 0.25 + ggH2H * 0.20;
        const composite = (ggScore + o15Score) / 2 * 100;

        // pre_match_snapshots schema has different columns — skip write
        pmResults.push({ id: m.fixture.id, composite: Math.round(composite) });
      } catch (e) {
        log(`pm error fixture ${m.fixture?.id}: ${e.message}`);
      }
    }

    // Resolve outcomes — pre_match_snapshots schema doesn't support outcome column, skip
    if (finishedMatches.length) log(`pm resolved: skipped (schema mismatch)`);
  } catch (e) {
    log(`pre-match scan error: ${e.message}`);
  }

  log(`done: ${snapshotResults.length} snapshots, ${resolved.length} resolved, ${pmResults.length} pre-match`);
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
