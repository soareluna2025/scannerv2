import { ALLOWED_LEAGUE_IDS } from './leagues.js';
import { query } from './db.js';
import { calcPlayerScore } from './calc-utils.js';

const LEAGUES = [...ALLOWED_LEAGUE_IDS];

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

  for (const row of rows) {
    await query(
      `INSERT INTO player_stats
        (player_id, fixture_id, team_id, team_name, player_name, rating, goals, assists,
         pass_accuracy, shots_on_target, minutes_played, player_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (player_id, fixture_id) DO UPDATE SET
         team_id=EXCLUDED.team_id, team_name=EXCLUDED.team_name,
         player_name=EXCLUDED.player_name, rating=EXCLUDED.rating,
         goals=EXCLUDED.goals, assists=EXCLUDED.assists,
         pass_accuracy=EXCLUDED.pass_accuracy, shots_on_target=EXCLUDED.shots_on_target,
         minutes_played=EXCLUDED.minutes_played, player_score=EXCLUDED.player_score`,
      [
        row.player_id, row.fixture_id, row.team_id, row.team_name, row.player_name,
        row.rating, row.goals, row.assists, row.pass_accuracy, row.shots_on_target,
        row.minutes_played, row.player_score,
      ]
    );
  }

  return rows.length;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  const { action, fixture_id, league_index } = req.query;

  // ── ACTION: collect one fixture ─────────────────────────────
  if (action === 'collect') {
    if (!fixture_id) return res.status(400).json({ error: 'fixture_id lipsa' });
    try {
      const count = await collectFixture(Number(fixture_id), key);
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

    try {
      // Mark in-progress
      await query(
        `INSERT INTO backfill_progress (league_id, status, last_run)
         VALUES ($1, $2, $3)
         ON CONFLICT (league_id) DO UPDATE SET status=$2, last_run=$3`,
        [leagueId, 'running', new Date().toISOString()]
      );

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
          const count = await collectFixture(fx.fixture.id, key);
          totalPlayers += count;
        } catch (e) { console.error('collectFixture error:', fx.fixture.id, e.message); }
        await sleep(150);
      }

      // Update progress — done
      await query(
        `INSERT INTO backfill_progress (league_id, status, fixtures_processed, players_upserted, last_run)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (league_id) DO UPDATE SET
           status=$2, fixtures_processed=$3, players_upserted=$4, last_run=$5`,
        [leagueId, 'done', fixtures.length, totalPlayers, new Date().toISOString()]
      );

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
      await query(
        `INSERT INTO backfill_progress (league_id, status, error_msg, last_run)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (league_id) DO UPDATE SET status=$2, error_msg=$3, last_run=$4`,
        [leagueId, 'error', e.message, new Date().toISOString()]
      ).catch(() => {});
      return res.status(500).json({ error: e.message, league_id: leagueId });
    }
  }

  // ── ACTION: progress report ─────────────────────────────────
  if (action === 'progress') {
    try {
      const r = await query(
        'SELECT league_id, status, fixtures_processed, players_upserted, last_run FROM backfill_progress'
      );
      const rows = r.rows;
      const done  = rows.filter(x => x.status === 'done').length;
      const error = rows.filter(x => x.status === 'error').length;
      return res.status(200).json({
        total: LEAGUES.length, done, error,
        pending: LEAGUES.length - done - error, rows,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'action trebuie sa fie collect, backfill sau progress' });
}
