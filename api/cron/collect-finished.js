function calcPlayerScore(rating, goals, assists, passAcc, sot) {
  const ratingNorm = rating ? (rating / 10 * 100) : 50;
  const goalsScore  = Math.min(100, (goals  || 0) * 25);
  const assistScore = Math.min(100, (assists || 0) * 20);
  const passScore   = passAcc != null ? parseFloat(passAcc) : 50;
  const shotScore   = Math.min(100, (sot    || 0) * 15);
  return Math.round(ratingNorm * 0.35 + goalsScore * 0.20 + assistScore * 0.15 + passScore * 0.20 + shotScore * 0.10);
}

async function collectFixture(fixtureId, key, sbUrl, sbKey) {
  const r = await fetch(
    `https://v3.football.api-sports.io/fixtures/players?fixture=${fixtureId}`,
    { headers: { 'x-apisports-key': key } }
  );
  const data = await r.json();
  const teams = data.response || [];
  if (!teams.length) return 0;

  const rows = [];
  for (const team of teams) {
    const teamId   = team.team?.id;
    const teamName = team.team?.name || '';
    for (const p of (team.players || [])) {
      const pl   = p.player || {};
      const stat = (p.statistics || [])[0] || {};
      const rating  = stat.games?.rating ? parseFloat(stat.games.rating) : null;
      const goals   = stat.goals?.total   || 0;
      const assists = stat.goals?.assists  || 0;
      const passAcc = stat.passes?.accuracy != null ? parseFloat(stat.passes.accuracy) : null;
      const sot     = stat.shots?.on       || 0;
      const mins    = stat.games?.minutes  || 0;
      rows.push({
        player_id:       pl.id,
        fixture_id:      fixtureId,
        team_id:         teamId,
        team_name:       teamName,
        player_name:     pl.name || '',
        rating,
        goals,
        assists,
        pass_accuracy:   passAcc,
        shots_on_target: sot,
        minutes_played:  mins,
        player_score:    calcPlayerScore(rating, goals, assists, passAcc, sot),
      });
    }
  }

  if (!rows.length) return 0;

  await fetch(`${sbUrl}/rest/v1/player_stats`, {
    method: 'POST',
    headers: {
      'apikey':        sbKey,
      'Authorization': `Bearer ${sbKey}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });

  return rows.length;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const key   = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_KEY;

  if (!key || !sbUrl || !sbKey)
    return res.status(500).json({ error: 'Environment vars lipsa' });

  const today = new Date().toISOString().split('T')[0];

  try {
    // Get today's FT fixtures
    const fxRes = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${today}&status=FT`,
      { headers: { 'x-apisports-key': key } }
    );
    const fxData = await fxRes.json();
    const fixtures = fxData.response || [];

    if (!fixtures.length) {
      await logCron(sbUrl, sbKey, 0, 0, 'ok', null);
      return res.status(200).json({ ok: true, message: 'No FT fixtures today', date: today });
    }

    // Filter out fixtures already in player_stats
    const fixtureIds = fixtures.map(f => f.fixture.id);
    const existRes = await fetch(
      `${sbUrl}/rest/v1/player_stats?fixture_id=in.(${fixtureIds.join(',')})&select=fixture_id`,
      { headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` } }
    );
    const existRows = await existRes.json();
    const existSet  = new Set(Array.isArray(existRows) ? existRows.map(r => r.fixture_id) : []);

    const toProcess = fixtures.filter(f => !existSet.has(f.fixture.id));

    let totalPlayers = 0;
    for (const fx of toProcess) {
      try {
        const count = await collectFixture(fx.fixture.id, key, sbUrl, sbKey);
        totalPlayers += count;
      } catch (_) {}
      await sleep(200);
    }

    await logCron(sbUrl, sbKey, toProcess.length, totalPlayers, 'ok', null);
    return res.status(200).json({
      ok: true,
      date: today,
      total_ft: fixtures.length,
      processed: toProcess.length,
      skipped: fixtures.length - toProcess.length,
      players: totalPlayers,
    });
  } catch (e) {
    await logCron(sbUrl, sbKey, 0, 0, 'error', e.message);
    return res.status(500).json({ error: e.message });
  }
}

async function logCron(sbUrl, sbKey, fixtures, players, status, errorMsg) {
  try {
    await fetch(`${sbUrl}/rest/v1/cron_logs`, {
      method: 'POST',
      headers: {
        'apikey':        sbKey,
        'Authorization': `Bearer ${sbKey}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({
        job_name:           'collect-finished',
        fixtures_processed: fixtures,
        players_upserted:   players,
        status,
        error_msg:          errorMsg,
      }),
    });
  } catch (_) {}
}
