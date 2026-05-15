import { ALLOWED_LEAGUE_IDS } from './leagues.js';
const LEAGUES = [...ALLOWED_LEAGUE_IDS];

function calcPlayerScore(rating, goals, assists, passAcc, sot) {
  const ratingNorm = rating ? (rating / 10 * 100) : 50;
  const goalsScore  = Math.min(100, (goals  || 0) * 25);
  const assistScore = Math.min(100, (assists || 0) * 20);
  const passScore   = passAcc != null ? parseFloat(passAcc) : 50;
  const shotScore   = Math.min(100, (sot    || 0) * 15);
  const score = Math.round(ratingNorm * 0.35 + goalsScore * 0.20 + assistScore * 0.15 + passScore * 0.20 + shotScore * 0.10);
  return isNaN(score) ? 0 : score;
}

async function collectFixture(fixtureId, key, sbUrl, sbKey) {
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
        player_id:      pl.id,
        fixture_id:     fixtureId,
        team_id:        teamId,
        team_name:      teamName,
        player_name:    pl.name || '',
        rating,
        goals,
        assists,
        pass_accuracy:  passAcc,
        shots_on_target: sot,
        minutes_played:  mins,
        player_score:   calcPlayerScore(rating, goals, assists, passAcc, sot),
      });
    }
  }

  rows = rows.filter(r => r.player_id != null && r.player_id !== undefined && r.fixture_id != null);
  if (!rows.length) return 0;

  await fetch(`${sbUrl}/rest/v1/player_stats?on_conflict=player_id,fixture_id`, {
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
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key    = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  const sbUrl  = process.env.SUPABASE_URL;
  const sbKey  = process.env.SUPABASE_KEY;

  if (!key)   return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });
  if (!sbUrl || !sbKey) return res.status(500).json({ error: 'Supabase neconfigurat' });

  const { action, fixture_id, league_index } = req.query;

  // ── ACTION: collect one fixture ─────────────────────────────
  if (action === 'collect') {
    if (!fixture_id) return res.status(400).json({ error: 'fixture_id lipsa' });
    try {
      const count = await collectFixture(Number(fixture_id), key, sbUrl, sbKey);
      return res.status(200).json({ ok: true, players: count, fixture_id: Number(fixture_id) });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── ACTION: backfill one league ─────────────────────────────
  if (action === 'backfill') {
    const idx = parseInt(league_index) || 0;
    if (idx < 0 || idx >= LEAGUES.length)
      return res.status(400).json({ error: 'league_index out of range', total: LEAGUES.length });

    const leagueId = LEAGUES[idx];
    const season   = new Date().getFullYear();

    try {
      // Mark in-progress
      await fetch(`${sbUrl}/rest/v1/backfill_progress`, {
        method: 'POST',
        headers: {
          'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({ league_id: leagueId, status: 'running', last_run: new Date().toISOString() }),
      });

      // Fetch last 10 finished fixtures
      const fxRes = await fetch(
        `https://v3.football.api-sports.io/fixtures?league=${leagueId}&last=10&status=FT`,
        { headers: { 'x-apisports-key': key } }
      );
      const fxData = await fxRes.json();
      const fixtures = fxData.response || [];

      let totalPlayers = 0;
      for (const fx of fixtures) {
        try {
          const count = await collectFixture(fx.fixture.id, key, sbUrl, sbKey);
          totalPlayers += count;
        } catch (e) { console.error('collectFixture error:', fx.fixture.id, e.message); }
        await sleep(150);
      }

      // Update progress
      await fetch(`${sbUrl}/rest/v1/backfill_progress`, {
        method: 'POST',
        headers: {
          'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          league_id: leagueId,
          status: 'done',
          fixtures_processed: fixtures.length,
          players_upserted: totalPlayers,
          last_run: new Date().toISOString(),
        }),
      });

      return res.status(200).json({
        ok: true,
        league_id: leagueId,
        league_index: idx,
        fixtures: fixtures.length,
        players: totalPlayers,
        next_index: idx + 1 < LEAGUES.length ? idx + 1 : null,
        total_leagues: LEAGUES.length,
      });
    } catch (e) {
      await fetch(`${sbUrl}/rest/v1/backfill_progress`, {
        method: 'POST',
        headers: {
          'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({ league_id: leagueId, status: 'error', error_msg: e.message, last_run: new Date().toISOString() }),
      }).catch(() => {});
      return res.status(500).json({ error: e.message, league_id: leagueId });
    }
  }

  // ── ACTION: progress report ─────────────────────────────────
  if (action === 'progress') {
    try {
      const r = await fetch(
        `${sbUrl}/rest/v1/backfill_progress?select=league_id,status,fixtures_processed,players_upserted,last_run`,
        { headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` } }
      );
      const rows = await r.json();
      const done  = Array.isArray(rows) ? rows.filter(x => x.status === 'done').length  : 0;
      const error = Array.isArray(rows) ? rows.filter(x => x.status === 'error').length : 0;
      return res.status(200).json({ total: LEAGUES.length, done, error, pending: LEAGUES.length - done - error, rows: Array.isArray(rows) ? rows : [] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'action trebuie sa fie collect, backfill sau progress' });
}
