// Vercel Cron Job — runs every minute
// Fetches live matches, calculates NGP/markets, stores snapshots in Supabase
// Resolves WIN/LOSS for finished matches, updates league_patterns every 10 runs

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kdyafjlwbximefwdhbnc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;
const FOOTBALL_KEY = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;

const LIVE_STATUS = new Set(['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT']);
const DONE_STATUS = new Set(['FT', 'AET', 'PEN']);

// --- Poisson helpers (mirrors index.html calcMarkets) ---
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

// --- Supabase REST helpers ---
async function sbFetch(path, method = 'GET', body = null) {
  if (!SUPABASE_KEY) throw new Error('SUPABASE_KEY not configured');
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=minimal' : '',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, opts);
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Supabase ${method} ${path} → ${r.status}: ${txt}`);
  }
  if (method === 'GET') return r.json();
  return null;
}

// upsert: insert or update by fixture_id + minute
async function upsertSnapshot(row) {
  await sbFetch('/match_snapshots', 'POST', row);
}

// patch outcome for a finished match
async function resolveOutcome(fixtureId, outcome, finalHome, finalAway) {
  await sbFetch(
    `/match_snapshots?fixture_id=eq.${fixtureId}&outcome=eq.LIVE`,
    'PATCH',
    { outcome, final_home: finalHome, final_away: finalAway, resolved_at: new Date().toISOString() }
  );
}

// read last N snapshots for a league to compute patterns
async function leagueSnapshots(leagueId, limit = 200) {
  return sbFetch(
    `/match_snapshots?league_id=eq.${leagueId}&outcome=neq.LIVE&order=created_at.desc&limit=${limit}`
  );
}

async function upsertLeaguePattern(row) {
  await sbFetch('/league_patterns?on_conflict=league_id', 'POST', row);
}

// track how many times the cron has run (simple module-level counter, resets on cold start)
let _runCount = 0;

function log(msg) {
  console.log(`[cron/scan] ${new Date().toISOString()} ${msg}`);
}

export default async function handler(req, res) {
  // Security: verify cron secret (skip check when CRON_SECRET not set — dev mode)
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
  if (!SUPABASE_KEY) {
    log('ERROR: no SUPABASE_KEY');
    return res.status(200).json({ error: 'No Supabase key' });
  }

  _runCount++;
  log(`run #${_runCount}`);

  // 1. Fetch live matches from API-Football (all statuses including FT for outcome resolution)
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

  // 2. Fetch recently finished matches (last 2h) for outcome resolution
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

  // 3. Process live matches → save snapshots
  const snapshotResults = [];
  for (const m of liveMatches) {
    try {
      const sh      = m.fixture?.status?.short || '';
      const elapsed = m.fixture?.status?.elapsed ?? 0;
      const extra   = m.fixture?.status?.extra ?? null;
      const f       = calcFeatures(m);
      const ng      = calcNextGoal(f);
      const mk      = calcMarkets(f);

      const row = {
        fixture_id:  m.fixture.id,
        league_id:   m.league?.id,
        league_name: m.league?.name,
        home_team:   m.teams?.home?.name,
        away_team:   m.teams?.away?.name,
        home_id:     m.teams?.home?.id,
        away_id:     m.teams?.away?.id,
        status_short: sh,
        minute:      elapsed,
        extra_time:  extra,
        home_goals:  m.goals?.home ?? 0,
        away_goals:  m.goals?.away ?? 0,
        home_xg:     f.hxg,
        away_xg:     f.axg,
        total_xg:    f.txg,
        total_shots: f.tSh,
        total_sot:   f.tSOT,
        total_corners: f.tC,
        total_da:    f.tDA,
        possession:  f.hp,
        ng:          ng,
        over05:      mk.over05,
        over15:      mk.over15,
        over25:      mk.over25,
        gg:          mk.gg,
        outcome:     'LIVE',
        created_at:  new Date().toISOString(),
      };

      await upsertSnapshot(row);
      snapshotResults.push({ id: m.fixture.id, ng, status: sh, minute: elapsed });
    } catch (e) {
      log(`snapshot error fixture ${m.fixture?.id}: ${e.message}`);
    }
  }

  // 4. Resolve outcomes for finished matches
  const resolved = [];
  for (const m of finishedMatches) {
    try {
      const fh = m.goals?.home ?? 0;
      const fa = m.goals?.away ?? 0;
      // Determine outcome from pre-match perspective: if we tracked this match, mark WIN (goals scored) or LOSS
      const outcome = (fh + fa) > 0 ? 'WIN' : 'LOSS';
      await resolveOutcome(m.fixture.id, outcome, fh, fa);
      resolved.push({ id: m.fixture.id, outcome, score: `${fh}-${fa}` });
    } catch (e) {
      log(`resolve error fixture ${m.fixture?.id}: ${e.message}`);
    }
  }

  // 5. Every 10 runs: recalculate league patterns from resolved snapshots
  if (_runCount % 10 === 0) {
    log('recalculating league patterns...');
    try {
      // Get distinct leagues from recent snapshots
      const recent = await sbFetch(
        '/match_snapshots?outcome=neq.LIVE&order=created_at.desc&limit=1000&select=league_id,league_name,over05,over15,over25,gg,ng,minute,outcome'
      );

      // Group by league
      const byLeague = {};
      for (const row of recent) {
        if (!row.league_id) continue;
        if (!byLeague[row.league_id]) byLeague[row.league_id] = { name: row.league_name, rows: [] };
        byLeague[row.league_id].rows.push(row);
      }

      for (const [leagueId, { name, rows }] of Object.entries(byLeague)) {
        if (rows.length < 5) continue;
        const wins  = rows.filter(r => r.outcome === 'WIN').length;
        const total = rows.length;
        const avg = (field) => rows.reduce((s, r) => s + (r[field] || 0), 0) / total;

        await upsertLeaguePattern({
          league_id:     parseInt(leagueId),
          league_name:   name,
          sample_size:   total,
          win_rate:      Math.round((wins / total) * 100),
          avg_ng:        Math.round(avg('ng')),
          avg_over05:    Math.round(avg('over05')),
          avg_over15:    Math.round(avg('over15')),
          avg_over25:    Math.round(avg('over25')),
          avg_gg:        Math.round(avg('gg')),
          updated_at:    new Date().toISOString(),
        });
      }
      log(`league patterns updated for ${Object.keys(byLeague).length} leagues`);
    } catch (e) {
      log(`league patterns error: ${e.message}`);
    }
  }

  log(`done: ${snapshotResults.length} snapshots, ${resolved.length} resolved`);
  return res.status(200).json({
    run: _runCount,
    snapshots: snapshotResults.length,
    resolved: resolved.length,
    live: snapshotResults,
    outcomes: resolved,
  });
}
