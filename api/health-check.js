import { query } from './db.js';

const TIMEOUT_MS = 8000;

function withTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), TIMEOUT_MS)
    ),
  ]);
}

async function safeRun(label, fn) {
  try {
    return await withTimeout(fn());
  } catch (e) {
    const isTimeout = e.message === 'TIMEOUT';
    return {
      status: isTimeout ? '⚠️ TIMEOUT' : '❌ FAIL',
      message: isTimeout
        ? `${label}: timeout după ${TIMEOUT_MS / 1000}s`
        : `${label}: ${e.message}`,
      data: {},
    };
  }
}

async function pgCount(table) {
  const r = await query(`SELECT COUNT(*) AS count FROM ${table}`);
  return parseInt(r.rows[0].count) || 0;
}

async function pgCountWhere(table, whereClause, params) {
  const r = await query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${whereClause}`, params);
  return parseInt(r.rows[0].count) || 0;
}

// Same formula as enrich.js getTeamStrengths → calcStr
function calcStr(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const rated = rows.filter(r => r.rating);
  const avgRating = rated.length
    ? rated.reduce((s, r) => s + Number(r.rating), 0) / rated.length
    : 5;
  const goalsPerGame = rows.reduce((s, r) => s + (r.goals || 0), 0) / rows.length;
  const withPass = rows.filter(r => r.pass_accuracy != null);
  const avgPassAcc = withPass.length
    ? withPass.reduce((s, r) => s + Number(r.pass_accuracy), 0) / withPass.length
    : 50;
  const avgSot = rows.reduce((s, r) => s + (r.shots_on_target || 0), 0) / rows.length;
  const topScorer = Math.max(...rows.map(r => r.goals || 0), 0);
  return Math.round(
    (avgRating / 10 * 100) * 0.35 +
    Math.min(100, goalsPerGame * 35) * 0.25 +
    avgPassAcc * 0.20 +
    Math.min(100, avgSot * 12) * 0.10 +
    Math.min(100, topScorer * 20) * 0.10
  );
}

// ── TEST 1: PostgreSQL conectat ──────────────────────────────────────────────
async function t1() {
  const count = await pgCount('player_stats');
  return {
    status: '✅ PASS',
    message: 'PostgreSQL conectat, tabel player_stats accesibil',
    data: { count },
  };
}

// ── TEST 2: player_stats are date ────────────────────────────────────────────
async function t2() {
  const [totalRes, sampleRes] = await Promise.all([
    query('SELECT COUNT(*) AS count FROM player_stats'),
    query('SELECT fixture_id, team_id FROM player_stats ORDER BY player_id DESC LIMIT 2000'),
  ]);

  const totalCount = parseInt(totalRes.rows[0].count) || 0;
  const arr = sampleRes.rows;
  const totalFixtures = new Set(arr.map(r => r.fixture_id)).size;
  const totalTeams    = new Set(arr.map(r => r.team_id)).size;

  if (totalCount === 0) {
    return {
      status: '⚠️ WARN',
      message: 'player_stats GOL — backfill nu a rulat încă',
      data: { total_players: 0, total_fixtures: 0, total_teams: 0 },
    };
  }

  return {
    status: '✅ PASS',
    message: `${totalCount.toLocaleString()} jucători din ${totalFixtures}+ meciuri`,
    data: { total_players: totalCount, total_fixtures: totalFixtures, total_teams: totalTeams },
  };
}

// ── TEST 3: backfill_progress status ────────────────────────────────────────
async function t3() {
  const [r, rSetting] = await Promise.all([
    query('SELECT status FROM backfill_progress'),
    query("SELECT value FROM app_settings WHERE key='backfill_running'").catch(() => ({ rows: [] })),
  ]);
  const arr = r.rows;

  const done        = arr.filter(x => x.status === 'done').length;
  const pending     = arr.filter(x => x.status === 'pending').length;
  const in_progress = arr.filter(x => x.status === 'in_progress').length;
  const error       = arr.filter(x => x.status === 'error').length;
  const total       = arr.length;
  const isRunning   = rSetting.rows[0]?.value === 'true';

  if (!total) {
    return {
      status: '⚠️ WARN',
      message: 'backfill_progress gol — backfill nu a pornit niciodată',
      data: { done: 0, pending: 0, in_progress: 0, error: 0, total: 0, running: false },
    };
  }

  const pass = done > 0 || isRunning;
  return {
    status: pass ? '✅ PASS' : '⚠️ WARN',
    message: isRunning && done === 0
      ? `Backfill activ — ${in_progress} ligi în progres, ${pending} în așteptare`
      : done > 0
        ? `${done}/${total} ligi procesate${isRunning ? ' (activ)' : ''}${error ? ` · ${error} erori` : ''}`
        : 'Niciun backfill completat — rulează Start Backfill din Settings',
    data: { done, pending, in_progress, error, total, running: isRunning },
  };
}

// ── TEST 4: team strength funcționează ───────────────────────────────────────
async function t4() {
  const teamRes = await query('SELECT team_id, team_name FROM player_stats LIMIT 1');
  const teamRows = teamRes.rows;
  if (!teamRows.length) {
    return {
      status: '❌ FAIL',
      message: 'Nu există date în player_stats — rulează Backfill mai întâi',
      data: {},
    };
  }

  const { team_id, team_name } = teamRows[0];
  const dataRes = await query(
    'SELECT rating, goals, pass_accuracy, shots_on_target FROM player_stats WHERE team_id = $1 ORDER BY player_id DESC LIMIT 110',
    [team_id]
  );
  const strength = calcStr(dataRes.rows);

  if (strength === null) {
    return {
      status: '❌ FAIL',
      message: `calcStr null pentru ${team_name} — date jucători insuficiente`,
      data: { team_id, team_name, team_strength: null },
    };
  }

  return {
    status: '✅ PASS',
    message: `Team strength calculat corect pentru ${team_name}`,
    data: { team_id, team_name, team_strength: strength },
  };
}

// ── TEST 5: Stratul 7 se activează în enrich ────────────────────────────────
async function t5() {
  const listRes = await query('SELECT DISTINCT team_id, team_name FROM player_stats LIMIT 2');
  const arr = listRes.rows;

  if (arr.length < 2) {
    return {
      status: '❌ FAIL',
      message: `Echipe insuficiente (${arr.length}/2) — rulează Backfill`,
      data: { hasPlayerData: false, teams_found: arr.length },
    };
  }

  const [{ team_id: homeId, team_name: homeName }, { team_id: awayId, team_name: awayName }] = arr;

  const [homeRes, awayRes] = await Promise.all([
    query('SELECT rating, goals, pass_accuracy, shots_on_target FROM player_stats WHERE team_id = $1 ORDER BY player_id DESC LIMIT 110', [homeId]),
    query('SELECT rating, goals, pass_accuracy, shots_on_target FROM player_stats WHERE team_id = $1 ORDER BY player_id DESC LIMIT 110', [awayId]),
  ]);

  const homeStrength = calcStr(homeRes.rows);
  const awayStrength = calcStr(awayRes.rows);
  const hasPlayerData = homeStrength !== null || awayStrength !== null;

  if (!hasPlayerData) {
    return {
      status: '❌ FAIL',
      message: 'Stratul 7 INACTIV — calcStr returnează null pentru ambele echipe',
      data: { hasPlayerData: false, homeTeamStrength: null, awayTeamStrength: null },
    };
  }

  const h = homeStrength ?? 50;
  const a = awayStrength ?? 50;
  const strScore = Math.round((h + a) / 2);
  const exampleConf = Math.round(50 * 0.20 + 55 * 0.18 + 50 * 0.13 + 50 * 0.13 + 50 * 0.13 + 60 * 0.08 + strScore * 0.15);

  return {
    status: '✅ PASS',
    message: `Stratul 7 ACTIV — ${homeName} (${homeStrength}) vs ${awayName} (${awayStrength})`,
    data: {
      hasPlayerData: true,
      homeTeamStrength: homeStrength,
      awayTeamStrength: awayStrength,
      confidenceScore: exampleConf,
      teams_tested: [homeName, awayName],
    },
  };
}

// ── TEST 6: Ponderi sumă = 100% ──────────────────────────────────────────────
function t6() {
  const withPlayerData    = { poisson: 20, forma: 18, h2h: 13, live: 13, ev: 13, consistenta: 8, jucatori: 15 };
  const withoutPlayerData = { poisson: 25, forma: 20, h2h: 15, live: 15, ev: 15, consistenta: 10 };

  const sumWith    = Object.values(withPlayerData).reduce((a, b) => a + b, 0);
  const sumWithout = Object.values(withoutPlayerData).reduce((a, b) => a + b, 0);
  const correct    = sumWith >= 99 && sumWith <= 101 && sumWithout >= 99 && sumWithout <= 101;

  return {
    status: correct ? '✅ PASS' : '❌ FAIL',
    message: correct
      ? 'Suma ponderilor = 100% (ambele configurații)'
      : `Sume incorecte: cu jucători=${sumWith}%, fără=${sumWithout}%`,
    data: {
      with_player_data:    { sum: sumWith,    breakdown: withPlayerData,    correct: sumWith >= 99 && sumWith <= 101 },
      without_player_data: { sum: sumWithout, breakdown: withoutPlayerData, correct: sumWithout >= 99 && sumWithout <= 101 },
    },
  };
}

// ── TEST 7: cron_logs există ─────────────────────────────────────────────────
async function t7() {
  const r = await query('SELECT * FROM cron_logs ORDER BY ran_at DESC LIMIT 5');
  const arr = r.rows;

  if (!arr.length) {
    return {
      status: '⚠️ WARN',
      message: 'cron_logs gol — cronul nu a rulat încă',
      data: { last_run: null, recent_logs: [] },
    };
  }

  const last = arr[0];
  const minsAgo = last.ran_at
    ? Math.round((Date.now() - new Date(last.ran_at).getTime()) / 60000)
    : null;
  const ageStr = minsAgo == null ? ''
    : minsAgo < 60 ? `acum ${minsAgo} minute`
    : `acum ${Math.round(minsAgo / 60)} ore`;

  return {
    status: '✅ PASS',
    message: `Ultimul cron: ${ageStr} (${last.status})`,
    data: {
      last_run:           last.ran_at,
      fixtures_processed: last.fixtures_processed,
      players_upserted:   last.players_upserted,
      status:             last.status,
      recent_logs: arr.map(l => ({
        ran_at:   l.ran_at,
        job_name: l.job_name,
        status:   l.status,
        fixtures: l.fixtures_processed,
        players:  l.players_upserted,
      })),
    },
  };
}

// ── TEST 8: API-Football conectat ────────────────────────────────────────────
async function t8(key) {
  if (!key) throw new Error('API_FOOTBALL_KEY lipsă');
  const r = await fetch('https://v3.football.api-sports.io/status', {
    headers: { 'x-apisports-key': key },
  });
  const data = await r.json();
  const account  = data.response?.account;
  const requests = data.response?.requests;

  if (!account) {
    const errors = data.errors;
    if (errors && (JSON.stringify(errors).includes('rate') || JSON.stringify(errors).includes('limit') || JSON.stringify(errors).includes('Too many'))) {
      return {
        status: '⚠️ WARNING',
        message: `API-Football rate limit temporar — retry in 1 min`,
        data: { errors },
      };
    }
    const errMsg = errors ? JSON.stringify(errors) : `HTTP ${r.status}`;
    throw new Error(`API-Football: ${errMsg}`);
  }

  const today    = requests?.current   ?? 0;
  const limitDay = requests?.limit_day ?? 100;

  return {
    status: '✅ PASS',
    message: `API-Football activ — ${today.toLocaleString()}/${limitDay.toLocaleString()} requests azi`,
    data: { requests_today: today, requests_limit: limitDay, remaining: limitDay - today },
  };
}

// ── TEST 9: fixtures table ───────────────────────────────────────────────────
async function t9() {
  const count = await pgCount('fixtures');
  if (count === 0) {
    return { status: '⚠️ WARNING', message: 'fixtures gol — collect-daily nu a rulat încă', data: { count: 0 } };
  }
  return { status: '✅ PASS', message: `${count.toLocaleString()} meciuri stocate în fixtures`, data: { count } };
}

// ── TEST 10: standings table ─────────────────────────────────────────────────
async function t10() {
  const count = await pgCount('standings');
  if (count === 0) {
    return { status: '⚠️ WARNING', message: 'standings gol — collect-daily nu a rulat încă', data: { count: 0 } };
  }
  return { status: '✅ PASS', message: `${count.toLocaleString()} clasamente stocate în standings`, data: { count } };
}

// ── TEST 11: h2h table ───────────────────────────────────────────────────────
async function t11() {
  const count = await pgCount('h2h');
  if (count === 0) {
    return { status: '⚠️ WARNING', message: 'h2h gol — scan.js nu a salvat încă date H2H', data: { count: 0 } };
  }
  return { status: '✅ PASS', message: `${count.toLocaleString()} meciuri H2H stocate`, data: { count } };
}

// ── TEST 12: form_stats table ────────────────────────────────────────────────
async function t12() {
  const count = await pgCount('form_stats');
  if (count === 0) {
    return { status: '⚠️ WARNING', message: 'form_stats gol — scan.js nu a salvat încă date de formă', data: { count: 0 } };
  }
  return { status: '✅ PASS', message: `${count.toLocaleString()} înregistrări în form_stats`, data: { count } };
}

// ── TEST 13: match_stats table ───────────────────────────────────────────────
async function t13() {
  const count = await pgCount('match_stats');
  if (count === 0) {
    return { status: '⚠️ WARNING', message: 'match_stats gol — collect-finished nu a rulat încă', data: { count: 0 } };
  }
  return { status: '✅ PASS', message: `${count.toLocaleString()} înregistrări în match_stats`, data: { count } };
}

// ── TEST 14: match_events table ──────────────────────────────────────────────
async function t14() {
  const count = await pgCount('match_events');
  if (count === 0) {
    return { status: '⚠️ WARNING', message: 'match_events gol — collect-finished nu a rulat încă', data: { count: 0 } };
  }
  return { status: '✅ PASS', message: `${count.toLocaleString()} evenimente stocate în match_events`, data: { count } };
}

// ── TEST 15: odds table ──────────────────────────────────────────────────────
async function t15() {
  const count = await pgCount('odds');
  if (count === 0) {
    return { status: '⚠️ WARNING', message: 'odds gol — collect-finished nu a salvat cote încă', data: { count: 0 } };
  }
  return { status: '✅ PASS', message: `${count.toLocaleString()} cote stocate în odds`, data: { count } };
}

// ── TEST 16: alerts table (total + azi) ──────────────────────────────────────
async function t16() {
  const today = new Date().toISOString().split('T')[0];
  const [countTotal, countToday] = await Promise.all([
    pgCount('alerts'),
    pgCountWhere('alerts', 'sent_at >= $1', [today]),
  ]);

  if (countTotal === 0) {
    return { status: '⚠️ WARNING', message: 'alerts gol — nicio alertă NGP generată încă', data: { count_total: 0, count_today: 0 } };
  }
  return {
    status: '✅ PASS',
    message: `${countTotal.toLocaleString()} alerte total, ${countToday} alerte NGP azi`,
    data: { count_total: countTotal, count_today: countToday },
  };
}

// ── TEST 17: live_stats (ultimele 24h) ───────────────────────────────────────
async function t17() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const count24h = await pgCountWhere('live_stats', 'recorded_at >= $1', [since]);

  if (count24h === 0) {
    return { status: '⚠️ WARNING', message: 'live_stats gol în ultimele 24h — niciun meci live înregistrat', data: { count_last_24h: 0 } };
  }
  return { status: '✅ PASS', message: `${count24h.toLocaleString()} snapshot-uri live în ultimele 24h`, data: { count_last_24h: count24h } };
}

// ── TEST 18: collect-daily cron activ ────────────────────────────────────────
async function t18() {
  const r = await query("SELECT * FROM cron_logs WHERE job_name = 'collect-daily' ORDER BY ran_at DESC LIMIT 1");
  const arr = r.rows;

  if (!arr.length) {
    return { status: '⚠️ WARNING', message: 'collect-daily nu a rulat niciodată — verifică cron-ul', data: { last_run: null } };
  }

  const last    = arr[0];
  const minsAgo = last.ran_at
    ? Math.round((Date.now() - new Date(last.ran_at).getTime()) / 60000)
    : null;
  const ageStr  = minsAgo == null ? ''
    : minsAgo < 60 ? `acum ${minsAgo} minute`
    : `acum ${Math.round(minsAgo / 60)} ore`;

  return {
    status: last.status === 'success' || last.status === 'ok' ? '✅ PASS' : '⚠️ WARNING',
    message: `collect-daily: ${ageStr} (${last.status})`,
    data: {
      last_run:           last.ran_at,
      status:             last.status,
      fixtures_processed: last.fixtures_processed,
      error_msg:          last.error_msg || null,
    },
  };
}

// ── WIN RATE din pre_match_snapshots ─────────────────────────────────────────
async function tWinRate() {
  try {
    const { rows } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE outcome='WIN')  AS wins,
        COUNT(*) FILTER (WHERE outcome='LOSS') AS losses,
        COUNT(*) FILTER (WHERE outcome IS NULL OR outcome='PENDING') AS pending,
        COUNT(*) FILTER (WHERE outcome IN ('WIN','LOSS')) AS resolved
      FROM pre_match_snapshots
    `);
    const r = rows[0] || {};
    const wins     = Number(r.wins    || 0);
    const losses   = Number(r.losses  || 0);
    const pending  = Number(r.pending || 0);
    const resolved = Number(r.resolved|| 0);
    return {
      correct:    wins,
      incorrect:  losses,
      pending,
      total:      resolved,
      percentage: resolved > 0 ? Math.round(wins / resolved * 100) : 0,
    };
  } catch (_) {
    return { correct: 0, total: 0, incorrect: 0, pending: 0, percentage: 0 };
  }
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;

  // ── LEAGUE SEARCH action ─────────────────────────────────────────────────
  if (req.query.action === 'leagues') {
    if (!apiKey) return res.status(500).json({ error: 'API key lipsă' });
    const { country, name } = req.query;
    const params = new URLSearchParams();
    if (country) params.set('country', country);
    if (name)    params.set('name',    name);
    const r = await fetch(`https://v3.football.api-sports.io/leagues?${params}`, {
      headers: { 'x-apisports-key': apiKey },
    });
    const data = await r.json();
    const leagues = (data.response || []).map(l => ({
      id:      l.league?.id,
      name:    l.league?.name,
      type:    l.league?.type,
      country: l.country?.name,
    }));
    return res.status(200).json({ total: leagues.length, leagues });
  }

  const [
    test1, test2, test3, test4, test5, test7, test8,
    test9, test10, test11, test12, test13, test14, test15, test16, test17, test18,
    winRateData,
  ] = await Promise.all([
    safeRun('PostgreSQL Connection', () => t1()),
    safeRun('Player Stats Data',     () => t2()),
    safeRun('Backfill Progress',     () => t3()),
    safeRun('Team Strength',         () => t4()),
    safeRun('Layer 7 Active',        () => t5()),
    safeRun('Cron Logs',             () => t7()),
    safeRun('API Football',          () => t8(apiKey)),
    safeRun('Fixtures Table',        () => t9()),
    safeRun('Standings Table',       () => t10()),
    safeRun('H2H Table',             () => t11()),
    safeRun('Form Stats Table',      () => t12()),
    safeRun('Match Stats Table',     () => t13()),
    safeRun('Match Events Table',    () => t14()),
    safeRun('Odds Table',            () => t15()),
    safeRun('Alerts Table',          () => t16()),
    safeRun('Live Stats (24h)',       () => t17()),
    safeRun('Collect Daily Cron',    () => t18()),
    tWinRate().catch(() => ({ correct: 0, total: 0, incorrect: 0, pending: 0, percentage: 0 })),
  ]);
  const test6 = t6(); // synchronous

  const tests = {
    postgres_connection: test1,
    player_stats_data:   test2,
    backfill_progress:   test3,
    team_strength:       test4,
    layer7_active:       test5,
    weights_sum:         test6,
    cron_logs:           test7,
    api_football:        test8,
    fixtures:            test9,
    standings:           test10,
    h2h:                 test11,
    form_stats:          test12,
    match_stats:         test13,
    match_events:        test14,
    odds:                test15,
    alerts:              test16,
    live_stats_24h:      test17,
    collect_daily_cron:  test18,
  };

  const passed   = Object.values(tests).filter(t => t.status.startsWith('✅')).length;
  const warnings = Object.values(tests).filter(t => t.status.startsWith('⚠️')).length;
  const failed   = Object.values(tests).filter(t => t.status.startsWith('❌')).length;

  const overall = failed > 0   ? '❌ FAILURES'
    : warnings > 0 ? '⚠️ WARNINGS'
    : '✅ ALL PASS';

  const critical_issues = Object.entries(tests)
    .filter(([, t]) => t.status.startsWith('❌'))
    .map(([key]) => key);

  return res.status(200).json({
    timestamp: new Date().toISOString(),
    overall,
    tests,
    summary: { passed, warnings, failed, critical_issues },
    winRate: winRateData,
  });
}
