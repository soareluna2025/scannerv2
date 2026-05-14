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

// Count rows using Supabase Content-Range header
async function sbCount(sbUrl, sbKey, table) {
  const r = await fetch(`${sbUrl}/rest/v1/${table}?select=*`, {
    headers: {
      apikey: sbKey,
      Authorization: `Bearer ${sbKey}`,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  });
  const cr = r.headers.get('content-range') || '';
  const parts = cr.split('/');
  return parseInt(parts[parts.length - 1] || '0') || 0;
}

// Count rows with an extra filter query string
async function sbCountFiltered(sbUrl, sbKey, table, filter) {
  const r = await fetch(`${sbUrl}/rest/v1/${table}?${filter}`, {
    headers: {
      apikey: sbKey,
      Authorization: `Bearer ${sbKey}`,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  });
  const cr = r.headers.get('content-range') || '';
  const parts = cr.split('/');
  return parseInt(parts[parts.length - 1] || '0') || 0;
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

// ── TEST 1: Supabase conectat ────────────────────────────────────────────────
async function t1(sbUrl, sbKey) {
  if (!sbUrl || !sbKey) throw new Error('SUPABASE_URL / SUPABASE_KEY lipsă');
  const count = await sbCount(sbUrl, sbKey, 'player_stats');
  return {
    status: '✅ PASS',
    message: 'Supabase conectat, tabel player_stats accesibil',
    data: { count },
  };
}

// ── TEST 2: player_stats are date ────────────────────────────────────────────
async function t2(sbUrl, sbKey) {
  const hdr = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };

  const [totalCount, sampleRes] = await Promise.all([
    sbCount(sbUrl, sbKey, 'player_stats'),
    fetch(
      `${sbUrl}/rest/v1/player_stats?select=fixture_id,team_id&order=player_id.desc&limit=2000`,
      { headers: hdr }
    ),
  ]);

  const sampleRows = await sampleRes.json();
  const arr = Array.isArray(sampleRows) ? sampleRows : [];
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
async function t3(sbUrl, sbKey) {
  const r = await fetch(
    `${sbUrl}/rest/v1/backfill_progress?select=status`,
    { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } }
  );
  const rows = await r.json();
  const arr = Array.isArray(rows) ? rows : [];

  const done        = arr.filter(x => x.status === 'done').length;
  const pending     = arr.filter(x => x.status === 'pending').length;
  const in_progress = arr.filter(x => x.status === 'running').length;
  const error       = arr.filter(x => x.status === 'error').length;
  const total       = arr.length;

  if (!total) {
    return {
      status: '⚠️ WARN',
      message: 'backfill_progress gol — backfill nu a pornit niciodată',
      data: { done: 0, pending: 0, in_progress: 0, error: 0, total: 0 },
    };
  }

  return {
    status: done > 0 ? '✅ PASS' : '⚠️ WARN',
    message: done > 0
      ? `${done}/${total} ligi procesate${error ? ` (${error} erori)` : ''}`
      : 'Niciun backfill completat — rulează Start Backfill din Settings',
    data: { done, pending, in_progress, error, total },
  };
}

// ── TEST 4: team strength funcționează ───────────────────────────────────────
async function t4(sbUrl, sbKey) {
  const hdr = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };

  const teamRes = await fetch(
    `${sbUrl}/rest/v1/player_stats?select=team_id,team_name&limit=1`,
    { headers: hdr }
  );
  const teamRows = await teamRes.json();
  if (!Array.isArray(teamRows) || !teamRows.length) {
    return {
      status: '❌ FAIL',
      message: 'Nu există date în player_stats — rulează Backfill mai întâi',
      data: {},
    };
  }

  const { team_id, team_name } = teamRows[0];

  const dataRes = await fetch(
    `${sbUrl}/rest/v1/player_stats?team_id=eq.${team_id}&select=rating,goals,pass_accuracy,shots_on_target&order=player_id.desc&limit=110`,
    { headers: hdr }
  );
  const playerRows = await dataRes.json();
  const strength = calcStr(Array.isArray(playerRows) ? playerRows : []);

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
async function t5(sbUrl, sbKey) {
  const hdr = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };

  const listRes = await fetch(
    `${sbUrl}/rest/v1/player_stats?select=team_id,team_name&limit=500`,
    { headers: hdr }
  );
  const listRows = await listRes.json();
  const arr = Array.isArray(listRows) ? listRows : [];

  const teamMap = new Map();
  for (const r of arr) {
    if (!teamMap.has(r.team_id)) teamMap.set(r.team_id, r.team_name);
    if (teamMap.size >= 2) break;
  }

  if (teamMap.size < 2) {
    return {
      status: '❌ FAIL',
      message: `Echipe insuficiente (${teamMap.size}/2) — rulează Backfill`,
      data: { hasPlayerData: false, teams_found: teamMap.size },
    };
  }

  const [[homeId, homeName], [awayId, awayName]] = [...teamMap.entries()];

  const [homeRes, awayRes] = await Promise.all([
    fetch(`${sbUrl}/rest/v1/player_stats?team_id=eq.${homeId}&select=rating,goals,pass_accuracy,shots_on_target&order=player_id.desc&limit=110`, { headers: hdr }),
    fetch(`${sbUrl}/rest/v1/player_stats?team_id=eq.${awayId}&select=rating,goals,pass_accuracy,shots_on_target&order=player_id.desc&limit=110`, { headers: hdr }),
  ]);
  const [homeRows, awayRows] = await Promise.all([homeRes.json(), awayRes.json()]);

  const homeStrength = calcStr(Array.isArray(homeRows) ? homeRows : []);
  const awayStrength = calcStr(Array.isArray(awayRows) ? awayRows : []);
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
async function t7(sbUrl, sbKey) {
  const r = await fetch(
    `${sbUrl}/rest/v1/cron_logs?select=*&order=ran_at.desc&limit=5`,
    { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } }
  );
  const rows = await r.json();
  const arr = Array.isArray(rows) ? rows : [];

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

  if (!account) throw new Error('Răspuns invalid de la API-Football');

  const today    = requests?.current   ?? 0;
  const limitDay = requests?.limit_day ?? 100;

  return {
    status: '✅ PASS',
    message: `API-Football activ — ${today.toLocaleString()}/${limitDay.toLocaleString()} requests azi`,
    data: { requests_today: today, requests_limit: limitDay, remaining: limitDay - today },
  };
}

// ── TEST 9: fixtures table ───────────────────────────────────────────────────
async function t9(sbUrl, sbKey) {
  const count = await sbCount(sbUrl, sbKey, 'fixtures');
  if (count === 0) {
    return {
      status: '⚠️ WARNING',
      message: 'fixtures gol — collect-daily nu a rulat încă',
      data: { count: 0 },
    };
  }
  return {
    status: '✅ PASS',
    message: `${count.toLocaleString()} meciuri stocate în fixtures`,
    data: { count },
  };
}

// ── TEST 10: standings table ─────────────────────────────────────────────────
async function t10(sbUrl, sbKey) {
  const count = await sbCount(sbUrl, sbKey, 'standings');
  if (count === 0) {
    return {
      status: '⚠️ WARNING',
      message: 'standings gol — collect-daily nu a rulat încă',
      data: { count: 0 },
    };
  }
  return {
    status: '✅ PASS',
    message: `${count.toLocaleString()} clasamente stocate în standings`,
    data: { count },
  };
}

// ── TEST 11: h2h table ───────────────────────────────────────────────────────
async function t11(sbUrl, sbKey) {
  const count = await sbCount(sbUrl, sbKey, 'h2h');
  if (count === 0) {
    return {
      status: '⚠️ WARNING',
      message: 'h2h gol — scan.js nu a salvat încă date H2H',
      data: { count: 0 },
    };
  }
  return {
    status: '✅ PASS',
    message: `${count.toLocaleString()} meciuri H2H stocate`,
    data: { count },
  };
}

// ── TEST 12: form_stats table ────────────────────────────────────────────────
async function t12(sbUrl, sbKey) {
  const count = await sbCount(sbUrl, sbKey, 'form_stats');
  if (count === 0) {
    return {
      status: '⚠️ WARNING',
      message: 'form_stats gol — scan.js nu a salvat încă date de formă',
      data: { count: 0 },
    };
  }
  return {
    status: '✅ PASS',
    message: `${count.toLocaleString()} înregistrări în form_stats`,
    data: { count },
  };
}

// ── TEST 13: match_stats table ───────────────────────────────────────────────
async function t13(sbUrl, sbKey) {
  const count = await sbCount(sbUrl, sbKey, 'match_stats');
  if (count === 0) {
    return {
      status: '⚠️ WARNING',
      message: 'match_stats gol — collect-finished nu a rulat încă',
      data: { count: 0 },
    };
  }
  return {
    status: '✅ PASS',
    message: `${count.toLocaleString()} înregistrări în match_stats`,
    data: { count },
  };
}

// ── TEST 14: match_events table ──────────────────────────────────────────────
async function t14(sbUrl, sbKey) {
  const count = await sbCount(sbUrl, sbKey, 'match_events');
  if (count === 0) {
    return {
      status: '⚠️ WARNING',
      message: 'match_events gol — collect-finished nu a rulat încă',
      data: { count: 0 },
    };
  }
  return {
    status: '✅ PASS',
    message: `${count.toLocaleString()} evenimente stocate în match_events`,
    data: { count },
  };
}

// ── TEST 15: odds table ──────────────────────────────────────────────────────
async function t15(sbUrl, sbKey) {
  const count = await sbCount(sbUrl, sbKey, 'odds');
  if (count === 0) {
    return {
      status: '⚠️ WARNING',
      message: 'odds gol — collect-finished nu a salvat cote încă',
      data: { count: 0 },
    };
  }
  return {
    status: '✅ PASS',
    message: `${count.toLocaleString()} cote stocate în odds`,
    data: { count },
  };
}

// ── TEST 16: alerts table (total + azi) ──────────────────────────────────────
async function t16(sbUrl, sbKey) {
  const today = new Date().toISOString().split('T')[0];
  const [countTotal, countToday] = await Promise.all([
    sbCount(sbUrl, sbKey, 'alerts'),
    sbCountFiltered(sbUrl, sbKey, 'alerts', `select=*&created_at=gte.${today}`),
  ]);

  if (countTotal === 0) {
    return {
      status: '⚠️ WARNING',
      message: 'alerts gol — nicio alertă NGP generată încă',
      data: { count_total: 0, count_today: 0 },
    };
  }
  return {
    status: '✅ PASS',
    message: `${countTotal.toLocaleString()} alerte total, ${countToday} alerte NGP azi`,
    data: { count_total: countTotal, count_today: countToday },
  };
}

// ── TEST 17: live_stats (ultimele 24h) ───────────────────────────────────────
async function t17(sbUrl, sbKey) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const count24h = await sbCountFiltered(
    sbUrl, sbKey, 'live_stats',
    `select=*&recorded_at=gte.${since}`
  );

  if (count24h === 0) {
    return {
      status: '⚠️ WARNING',
      message: 'live_stats gol în ultimele 24h — niciun meci live înregistrat',
      data: { count_last_24h: 0 },
    };
  }
  return {
    status: '✅ PASS',
    message: `${count24h.toLocaleString()} snapshot-uri live în ultimele 24h`,
    data: { count_last_24h: count24h },
  };
}

// ── TEST 18: collect-daily cron activ ────────────────────────────────────────
async function t18(sbUrl, sbKey) {
  const r = await fetch(
    `${sbUrl}/rest/v1/cron_logs?job_name=eq.collect-daily&select=*&order=ran_at.desc&limit=1`,
    { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } }
  );
  const rows = await r.json();
  const arr  = Array.isArray(rows) ? rows : [];

  if (!arr.length) {
    return {
      status: '⚠️ WARNING',
      message: 'collect-daily nu a rulat niciodată — verifică cron-ul de la 06:00',
      data: { last_run: null },
    };
  }

  const last    = arr[0];
  const minsAgo = last.ran_at
    ? Math.round((Date.now() - new Date(last.ran_at).getTime()) / 60000)
    : null;
  const ageStr  = minsAgo == null ? ''
    : minsAgo < 60 ? `acum ${minsAgo} minute`
    : `acum ${Math.round(minsAgo / 60)} ore`;

  return {
    status: last.status === 'success' ? '✅ PASS' : '⚠️ WARNING',
    message: `collect-daily: ${ageStr} (${last.status})`,
    data: {
      last_run:           last.ran_at,
      status:             last.status,
      fixtures_processed: last.fixtures_processed,
      error_msg:          last.error_msg || null,
    },
  };
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sbUrl  = process.env.SUPABASE_URL;
  const sbKey  = process.env.SUPABASE_KEY;
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
  ] = await Promise.all([
    safeRun('Supabase Connection', () => t1(sbUrl, sbKey)),
    safeRun('Player Stats Data',   () => t2(sbUrl, sbKey)),
    safeRun('Backfill Progress',   () => t3(sbUrl, sbKey)),
    safeRun('Team Strength',       () => t4(sbUrl, sbKey)),
    safeRun('Layer 7 Active',      () => t5(sbUrl, sbKey)),
    safeRun('Cron Logs',           () => t7(sbUrl, sbKey)),
    safeRun('API Football',        () => t8(apiKey)),
    safeRun('Fixtures Table',      () => t9(sbUrl, sbKey)),
    safeRun('Standings Table',     () => t10(sbUrl, sbKey)),
    safeRun('H2H Table',           () => t11(sbUrl, sbKey)),
    safeRun('Form Stats Table',    () => t12(sbUrl, sbKey)),
    safeRun('Match Stats Table',   () => t13(sbUrl, sbKey)),
    safeRun('Match Events Table',  () => t14(sbUrl, sbKey)),
    safeRun('Odds Table',          () => t15(sbUrl, sbKey)),
    safeRun('Alerts Table',        () => t16(sbUrl, sbKey)),
    safeRun('Live Stats (24h)',     () => t17(sbUrl, sbKey)),
    safeRun('Collect Daily Cron',  () => t18(sbUrl, sbKey)),
  ]);
  const test6 = t6(); // synchronous

  const tests = {
    supabase_connection: test1,
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
  });
}
