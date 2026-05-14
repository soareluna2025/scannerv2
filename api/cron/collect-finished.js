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
        player_id:          pl.id,
        fixture_id:         fixtureId,
        team_id:            teamId,
        team_name:          teamName,
        player_name:        pl.name || '',
        rating,
        goals,
        assists,
        pass_accuracy:      passAcc,
        shots_on_target:    sot,
        minutes_played:     mins,
        player_score:       calcPlayerScore(rating, goals, assists, passAcc, sot),
        position:           stat.games?.position || null,
        age:                pl.age || null,
        yellow_cards:       stat.cards?.yellow || 0,
        red_cards:          stat.cards?.red || 0,
        offsides:           stat.offsides || 0,
        duels_total:        stat.duels?.total || 0,
        duels_won:          stat.duels?.won || 0,
        dribbles_attempts:  stat.dribbles?.attempts || 0,
        dribbles_success:   stat.dribbles?.success || 0,
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

async function collectMatchStats(fixtureId, homeTeamId, key, sbUrl, sbKey) {
  const r = await fetch(
    `https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`,
    { headers: { 'x-apisports-key': key } }
  );
  const data = await r.json();
  const teamStats = data.response || [];
  if (!teamStats.length) return 0;

  const rows = [];
  for (const teamStat of teamStats) {
    const s = {};
    for (const entry of teamStat.statistics) s[entry.type] = entry.value;
    rows.push({
      fixture_id:        fixtureId,
      team_id:           teamStat.team.id,
      team_name:         teamStat.team.name,
      is_home:           teamStat.team.id === homeTeamId,
      possession:        parseFloat(s['Ball Possession']) || null,
      shots_total:       parseInt(s['Total Shots'])       || 0,
      shots_on_target:   parseInt(s['Shots on Goal'])     || 0,
      shots_off_target:  parseInt(s['Shots off Goal'])    || 0,
      shots_blocked:     parseInt(s['Blocked Shots'])     || 0,
      xg:                parseFloat(s['expected_goals'])  || null,
      corners:           parseInt(s['Corner Kicks'])      || 0,
      fouls:             parseInt(s['Fouls'])              || 0,
      yellow_cards:      parseInt(s['Yellow Cards'])       || 0,
      red_cards:         parseInt(s['Red Cards'])          || 0,
      offsides:          parseInt(s['Offsides'])           || 0,
      passes_total:      parseInt(s['Total passes'])      || 0,
      passes_accurate:   parseInt(s['Passes accurate'])   || 0,
      pass_accuracy:     parseFloat(s['Passes %'])        || null,
      attacks:           parseInt(s['Attacks'])            || 0,
      dangerous_attacks: parseInt(s['Dangerous Attacks']) || 0,
    });
  }

  await fetch(`${sbUrl}/rest/v1/match_stats?on_conflict=fixture_id,team_id`, {
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

async function collectMatchEvents(fixtureId, key, sbUrl, sbKey) {
  const r = await fetch(
    `https://v3.football.api-sports.io/fixtures/events?fixture=${fixtureId}`,
    { headers: { 'x-apisports-key': key } }
  );
  const data = await r.json();
  const events = data.response || [];
  if (!events.length) return 0;

  const rows = events.map(ev => ({
    fixture_id:    fixtureId,
    team_id:       ev.team?.id    || null,
    player_id:     ev.player?.id  || null,
    player_name:   ev.player?.name || null,
    assist_id:     ev.assist?.id   || null,
    assist_name:   ev.assist?.name || null,
    event_type:    ev.type,
    event_detail:  ev.detail,
    event_comment: ev.comments    || null,
    minute:        ev.time?.elapsed || 0,
    extra_time:    ev.time?.extra   || null,
  }));

  // Delete existing events for this fixture before re-inserting (prevents duplicates on re-run)
  await fetch(`${sbUrl}/rest/v1/match_events?fixture_id=eq.${fixtureId}`, {
    method: 'DELETE',
    headers: {
      'apikey':        sbKey,
      'Authorization': `Bearer ${sbKey}`,
    },
  });

  await fetch(`${sbUrl}/rest/v1/match_events?on_conflict=fixture_id,team_id,minute,event_type`, {
    method: 'POST',
    headers: {
      'apikey':        sbKey,
      'Authorization': `Bearer ${sbKey}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });

  return rows.length;
}

async function collectOdds(fixtureId, key, sbUrl, sbKey) {
  const r = await fetch(
    `https://v3.football.api-sports.io/odds?fixture=${fixtureId}&bookmaker=8`,
    { headers: { 'x-apisports-key': key } }
  );
  const data = await r.json();
  const oddsResponse = data.response?.[0] || null;
  if (!oddsResponse) return 0;

  const rows = [];
  for (const bookmaker of oddsResponse.bookmakers || []) {
    for (const bet of bookmaker.bets || []) {
      for (const value of bet.values || []) {
        rows.push({
          fixture_id:     fixtureId,
          bookmaker_id:   bookmaker.id,
          bookmaker_name: bookmaker.name,
          market:         bet.name,
          label:          value.value,
          odd_value:      parseFloat(value.odd),
          recorded_at:    new Date().toISOString(),
        });
      }
    }
  }

  if (!rows.length) return 0;

  await fetch(`${sbUrl}/rest/v1/odds?on_conflict=fixture_id,bookmaker_id,market,label`, {
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

    let totalPlayers    = 0;
    let totalMatchStats = 0;
    let totalEvents     = 0;
    let totalOdds       = 0;

    for (const fx of toProcess) {
      const fixtureId  = fx.fixture.id;
      const homeTeamId = fx.teams?.home?.id;

      try {
        const count = await collectFixture(fixtureId, key, sbUrl, sbKey);
        totalPlayers += count;
      } catch (_) {}

      try {
        const count = await collectMatchStats(fixtureId, homeTeamId, key, sbUrl, sbKey);
        totalMatchStats += count;
      } catch (_) {}

      try {
        const count = await collectMatchEvents(fixtureId, key, sbUrl, sbKey);
        totalEvents += count;
      } catch (_) {}

      try {
        const count = await collectOdds(fixtureId, key, sbUrl, sbKey);
        totalOdds += count;
      } catch (_) {}

      await sleep(200);
    }

    await logCron(sbUrl, sbKey, toProcess.length, totalPlayers, 'ok', null);
    return res.status(200).json({
      ok: true,
      date: today,
      total_ft:    fixtures.length,
      processed:   toProcess.length,
      skipped:     fixtures.length - toProcess.length,
      players:     totalPlayers,
      match_stats: totalMatchStats,
      events:      totalEvents,
      odds:        totalOdds,
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
