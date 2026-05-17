import { query } from '../db.js';
import { calcPlayerScore } from '../calc-utils.js';

async function collectFixture(fixtureId, key) {
  const r = await fetch(
    `https://v3.football.api-sports.io/fixtures/players?fixture=${fixtureId}`,
    { headers: { 'x-apisports-key': key } }
  );
  const data = await r.json();
  const teams = data.response || [];
  if (!teams.length) return 0;

  let rows = [];
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
        player_id:         pl.id,
        fixture_id:        fixtureId,
        team_id:           teamId,
        team_name:         teamName,
        player_name:       pl.name || '',
        position:          stat.games?.position || null,
        rating,
        goals,
        assists,
        pass_accuracy:     passAcc,
        shots_on_target:   sot,
        minutes_played:    mins,
        yellow_cards:      stat.cards?.yellow || 0,
        red_cards:         stat.cards?.red || 0,
        dribbles_success:  stat.dribbles?.success || 0,
        player_score:      calcPlayerScore(rating, goals, assists, passAcc, sot),
      });
    }
  }

  rows = rows.filter(r => r.player_id != null && r.player_id !== undefined && r.fixture_id != null);
  if (!rows.length) return 0;

  for (const row of rows) {
    await query(
      `INSERT INTO player_stats
         (player_id, fixture_id, team_id, team_name, player_name, position, rating,
          goals, assists, pass_accuracy, shots_on_target, minutes_played,
          yellow_cards, red_cards, dribbles_success, player_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (player_id, fixture_id) DO UPDATE SET
         team_id=EXCLUDED.team_id, team_name=EXCLUDED.team_name,
         player_name=EXCLUDED.player_name, position=EXCLUDED.position,
         rating=EXCLUDED.rating, goals=EXCLUDED.goals, assists=EXCLUDED.assists,
         pass_accuracy=EXCLUDED.pass_accuracy, shots_on_target=EXCLUDED.shots_on_target,
         minutes_played=EXCLUDED.minutes_played, yellow_cards=EXCLUDED.yellow_cards,
         red_cards=EXCLUDED.red_cards, dribbles_success=EXCLUDED.dribbles_success,
         player_score=EXCLUDED.player_score`,
      [
        row.player_id, row.fixture_id, row.team_id, row.team_name, row.player_name,
        row.position, row.rating, row.goals, row.assists, row.pass_accuracy,
        row.shots_on_target, row.minutes_played, row.yellow_cards, row.red_cards,
        row.dribbles_success, row.player_score,
      ]
    );
  }

  return rows.length;
}

async function collectMatchStats(fixtureId, homeTeamId, key) {
  const r = await fetch(
    `https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`,
    { headers: { 'x-apisports-key': key } }
  );
  const data = await r.json();
  const teamStats = data.response || [];
  if (!teamStats.length) return 0;

  for (const teamStat of teamStats) {
    const s = {};
    for (const entry of teamStat.statistics) s[entry.type] = entry.value;

    const isHome = teamStat.team.id === homeTeamId;

    await query(
      `INSERT INTO match_stats
         (fixture_id, team_id, team_name, is_home,
          shots_on_goal, shots_off_goal, shots_total, shots_blocked,
          shots_inside_box, shots_outside_box,
          xg, possession, passes_total, passes_accurate, passes_pct,
          fouls, yellow_cards, red_cards, corners, offsides, goalkeeper_saves)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (fixture_id, team_id) DO UPDATE SET
         team_name=EXCLUDED.team_name, is_home=EXCLUDED.is_home,
         shots_on_goal=EXCLUDED.shots_on_goal, shots_off_goal=EXCLUDED.shots_off_goal,
         shots_total=EXCLUDED.shots_total, shots_blocked=EXCLUDED.shots_blocked,
         shots_inside_box=EXCLUDED.shots_inside_box, shots_outside_box=EXCLUDED.shots_outside_box,
         xg=EXCLUDED.xg, possession=EXCLUDED.possession,
         passes_total=EXCLUDED.passes_total, passes_accurate=EXCLUDED.passes_accurate,
         passes_pct=EXCLUDED.passes_pct, fouls=EXCLUDED.fouls,
         yellow_cards=EXCLUDED.yellow_cards, red_cards=EXCLUDED.red_cards,
         corners=EXCLUDED.corners, offsides=EXCLUDED.offsides,
         goalkeeper_saves=EXCLUDED.goalkeeper_saves`,
      [
        fixtureId, teamStat.team.id, teamStat.team.name, isHome,
        parseInt(s['Shots on Goal'])      || 0,
        parseInt(s['Shots off Goal'])     || 0,
        parseInt(s['Total Shots'])        || 0,
        parseInt(s['Blocked Shots'])      || 0,
        parseInt(s['Shots insidebox'])    || 0,
        parseInt(s['Shots outsidebox'])   || 0,
        parseFloat(s['expected_goals'])   || null,
        parseFloat(s['Ball Possession'])  || null,
        parseInt(s['Total passes'])       || 0,
        parseInt(s['Passes accurate'])    || 0,
        parseFloat(s['Passes %'])         || null,
        parseInt(s['Fouls'])              || 0,
        parseInt(s['Yellow Cards'])       || 0,
        parseInt(s['Red Cards'])          || 0,
        parseInt(s['Corner Kicks'])       || 0,
        parseInt(s['Offsides'])           || 0,
        parseInt(s['Goalkeeper Saves'])   || 0,
      ]
    );
  }

  return teamStats.length;
}

async function collectMatchEvents(fixtureId, key) {
  const r = await fetch(
    `https://v3.football.api-sports.io/fixtures/events?fixture=${fixtureId}`,
    { headers: { 'x-apisports-key': key } }
  );
  const data = await r.json();
  const events = data.response || [];
  if (!events.length) return 0;

  // Delete existing events before re-inserting
  await query('DELETE FROM match_events WHERE fixture_id = $1', [fixtureId]);

  for (const ev of events) {
    await query(
      `INSERT INTO match_events
         (fixture_id, elapsed, elapsed_extra, team_id, player_id, player_name,
          assist_id, assist_name, type, detail, comments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        fixtureId,
        ev.time?.elapsed || 0,
        ev.time?.extra   || null,
        ev.team?.id      || null,
        ev.player?.id    || null,
        ev.player?.name  || null,
        ev.assist?.id    || null,
        ev.assist?.name  || null,
        ev.type,
        ev.detail,
        ev.comments      || null,
      ]
    );
  }

  return events.length;
}

async function collectOdds(fixtureId, key) {
  const r = await fetch(
    `https://v3.football.api-sports.io/odds?fixture=${fixtureId}&bookmaker=8`,
    { headers: { 'x-apisports-key': key } }
  );
  const data = await r.json();
  const oddsResponse = data.response?.[0] || null;
  if (!oddsResponse) return 0;

  let count = 0;
  for (const bookmaker of oddsResponse.bookmakers || []) {
    for (const bet of bookmaker.bets || []) {
      for (const v of bet.values || []) {
        const oddVal = parseFloat(v.odd) || null;
        if (!oddVal) continue;
        await query(
          `INSERT INTO odds
             (fixture_id, bookmaker_id, bookmaker_name, bet_id, bet_name, value_name, value_odd)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (fixture_id, bookmaker_id, bet_id, value_name) DO UPDATE SET
             value_odd=EXCLUDED.value_odd, collected_at=NOW()`,
          [fixtureId, bookmaker.id, bookmaker.name, bet.id, bet.name, v.value, oddVal]
        );
        count++;
      }
    }
  }

  return count;
}

async function logCron(fixtures, players, status, errorMsg) {
  try {
    await query(
      `INSERT INTO cron_logs (job_name, fixtures_processed, players_upserted, status, error_msg)
       VALUES ($1,$2,$3,$4,$5)`,
      ['collect-finished', fixtures, players, status, errorMsg || null]
    );
  } catch (_) {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;

  if (!key) return res.status(500).json({ error: 'Environment vars lipsa' });

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
      await logCron(0, 0, 'ok', null);
      return res.status(200).json({ ok: true, message: 'No FT fixtures today', date: today });
    }

    // Filter out fixtures already in player_stats
    const fixtureIds = fixtures.map(f => f.fixture.id);
    const existRes = await query(
      'SELECT DISTINCT fixture_id FROM player_stats WHERE fixture_id = ANY($1)',
      [fixtureIds]
    );
    const existSet = new Set(existRes.rows.map(r => r.fixture_id));

    const toProcess = fixtures.filter(f => !existSet.has(f.fixture.id));

    let totalPlayers    = 0;
    let totalMatchStats = 0;
    let totalEvents     = 0;
    let totalOdds       = 0;

    for (const fx of toProcess) {
      const fixtureId  = fx.fixture.id;
      const homeTeamId = fx.teams?.home?.id;

      try {
        const count = await collectFixture(fixtureId, key);
        totalPlayers += count;
      } catch (e) { console.error('collectFixture error:', fixtureId, e.message); }

      try {
        const count = await collectMatchStats(fixtureId, homeTeamId, key);
        totalMatchStats += count;
      } catch (_) {}

      try {
        const count = await collectMatchEvents(fixtureId, key);
        totalEvents += count;
      } catch (_) {}

      try {
        const count = await collectOdds(fixtureId, key);
        totalOdds += count;
      } catch (_) {}

      await sleep(200);
    }

    await logCron(toProcess.length, totalPlayers, 'ok', null);
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
    await logCron(0, 0, 'error', e.message);
    return res.status(500).json({ error: e.message });
  }
}
