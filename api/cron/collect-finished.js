import { query } from '../db.js';
import { calcPlayerScore } from '../calc-utils.js';
import { fetchApiFootball } from '../utils/fetch-api.js';
import { ALLOWED_LEAGUE_IDS } from '../leagues.js';
import { isAllowedMatch } from '../utils/league-filter.js';

// ── ELO incremental (PASUL 4) — actualizează ELO global la fiecare meci FT nou.
// Idempotent prin elo_applied (un meci aplicat o singură dată; build-elo, sursa
// de adevăr săptămânală, marchează toate fixturile). NEFOLOSIT în scoring.
function eloK(games) { return games < 10 ? 40 : games < 30 ? 32 : 24; }
async function ensureEloTables() {
  await query(`CREATE TABLE IF NOT EXISTS elo_ratings (
    team_id INTEGER NOT NULL, league_id INTEGER NOT NULL,
    elo NUMERIC(8,2) DEFAULT 1500, games INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (team_id, league_id))`);
  await query(`CREATE TABLE IF NOT EXISTS elo_applied (fixture_id INTEGER PRIMARY KEY)`);
}
async function updateEloForFixture(fx) {
  const fid = fx.fixture?.id;
  const lid = fx.league?.id;
  const hId = fx.teams?.home?.id, aId = fx.teams?.away?.id;
  const hg = fx.goals?.home, ag = fx.goals?.away;
  if (!fid || !lid || !hId || !aId || hg == null || ag == null) return false;
  // Idempotență: dacă meciul a fost deja aplicat → skip (evită dublă numărare).
  const seen = await query(`SELECT 1 FROM elo_applied WHERE fixture_id = $1`, [fid]);
  if (seen.rows.length) return false;
  const cur = await query(
    `SELECT team_id, elo, games FROM elo_ratings WHERE league_id = $1 AND team_id = ANY($2)`,
    [lid, [hId, aId]]
  );
  const map = {};
  cur.rows.forEach(r => { map[r.team_id] = { elo: Number(r.elo), games: r.games }; });
  const H = map[hId] || { elo: 1500, games: 0 };
  const A = map[aId] || { elo: 1500, games: 0 };
  const expH = 1 / (1 + Math.pow(10, (A.elo - H.elo) / 400));
  const actH = hg > ag ? 1 : hg === ag ? 0.5 : 0;
  const newH = H.elo + eloK(H.games) * (actH - expH);
  const newA = A.elo + eloK(A.games) * ((1 - actH) - (1 - expH));
  const up = (tid, elo, games) => query(
    `INSERT INTO elo_ratings (team_id, league_id, elo, games, updated_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (team_id, league_id) DO UPDATE SET
       elo=EXCLUDED.elo, games=EXCLUDED.games, updated_at=NOW()`,
    [tid, lid, +elo.toFixed(2), games]
  );
  await up(hId, newH, H.games + 1);
  await up(aId, newA, A.games + 1);
  await query(`INSERT INTO elo_applied (fixture_id) VALUES ($1) ON CONFLICT DO NOTHING`, [fid]);
  return true;
}

async function collectFixture(fixtureId) {
  const r = await fetchApiFootball(`/fixtures/players?fixture=${fixtureId}`);
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
      const shTotal = stat.shots?.total    || 0;
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
        shots_total:       shTotal,
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
          goals, assists, pass_accuracy, shots_total, shots_on_target, minutes_played,
          yellow_cards, red_cards, dribbles_success, player_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (player_id, fixture_id) DO UPDATE SET
         team_id=EXCLUDED.team_id, team_name=EXCLUDED.team_name,
         player_name=EXCLUDED.player_name, position=EXCLUDED.position,
         rating=EXCLUDED.rating, goals=EXCLUDED.goals, assists=EXCLUDED.assists,
         pass_accuracy=EXCLUDED.pass_accuracy, shots_total=EXCLUDED.shots_total,
         shots_on_target=EXCLUDED.shots_on_target,
         minutes_played=EXCLUDED.minutes_played, yellow_cards=EXCLUDED.yellow_cards,
         red_cards=EXCLUDED.red_cards, dribbles_success=EXCLUDED.dribbles_success,
         player_score=EXCLUDED.player_score`,
      [
        row.player_id, row.fixture_id, row.team_id, row.team_name, row.player_name,
        row.position, row.rating, row.goals, row.assists, row.pass_accuracy,
        row.shots_total, row.shots_on_target, row.minutes_played, row.yellow_cards,
        row.red_cards, row.dribbles_success, row.player_score,
      ]
    );
  }

  return rows.length;
}

async function collectMatchStats(fixtureId, homeTeamId) {
  const r = await fetchApiFootball(`/fixtures/statistics?fixture=${fixtureId}`);
  const data = await r.json();
  const teamStats = data.response || [];
  if (!teamStats.length) return 0;

  for (const teamStat of teamStats) {
    const s = {};
    for (const entry of teamStat.statistics) s[entry.type] = entry.value;

    const isHome = teamStat.team.id === homeTeamId;

    await query(
      `INSERT INTO match_stats
         (fixture_id, team_id, team_name,
          shots_on_goal, shots_total, blocked_shots,
          shots_insidebox, shots_outsidebox,
          expected_goals, ball_possession,
          total_passes, passes_accurate, pass_percentage,
          fouls, yellow_cards, red_cards, corner_kicks, offsides, goalkeeper_saves)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (fixture_id, team_id) DO UPDATE SET
         team_name=EXCLUDED.team_name,
         shots_on_goal=EXCLUDED.shots_on_goal,
         shots_total=EXCLUDED.shots_total, blocked_shots=EXCLUDED.blocked_shots,
         shots_insidebox=EXCLUDED.shots_insidebox, shots_outsidebox=EXCLUDED.shots_outsidebox,
         expected_goals=EXCLUDED.expected_goals, ball_possession=EXCLUDED.ball_possession,
         total_passes=EXCLUDED.total_passes, passes_accurate=EXCLUDED.passes_accurate,
         pass_percentage=EXCLUDED.pass_percentage, fouls=EXCLUDED.fouls,
         yellow_cards=EXCLUDED.yellow_cards, red_cards=EXCLUDED.red_cards,
         corner_kicks=EXCLUDED.corner_kicks, offsides=EXCLUDED.offsides,
         goalkeeper_saves=EXCLUDED.goalkeeper_saves`,
      [
        fixtureId, teamStat.team.id, teamStat.team.name,
        parseInt(s['Shots on Goal'])      || 0,
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

async function collectMatchEvents(fixtureId) {
  const r = await fetchApiFootball(`/fixtures/events?fixture=${fixtureId}`);
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

async function collectOdds(fixtureId) {
  const r = await fetchApiFootball(`/odds?fixture=${fixtureId}&bookmaker=8`);
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

function dateOffset(baseYmd, offsetDays) {
  const d = new Date(baseYmd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'Environment vars lipsa' });

  const today = new Date().toISOString().split('T')[0];
  // FIX 2 — fereastră 3 zile retroactiv: azi + ultimele 2 zile
  const dates = [0, -1, -2].map(off => dateOffset(today, off));

  try {
    // Pas 1: agregează fixturile FT/AET/PEN din toate cele 3 zile, dedupate pe fid
    // FIX 3 — include AET + PEN (prelungiri + penalty), nu doar FT
    const allFixtures = [];
    const seenFids    = new Set();
    let apiTotal = 0;
    for (const dt of dates) {
      const fxRes  = await fetchApiFootball(`/fixtures?date=${dt}&status=FT-AET-PEN`);
      const fxData = await fxRes.json();
      const list   = fxData.response || [];
      apiTotal += list.length;
      for (const f of list) {
        const fid = f.fixture?.id;
        if (!fid || seenFids.has(fid)) continue;
        seenFids.add(fid);
        allFixtures.push(f);
      }
    }

    // FIX 1 — filtru ALLOWED_LEAGUE_IDS + isAllowedMatch (elimină women/youth/Tier3+)
    const allowed = new Set([...ALLOWED_LEAGUE_IDS]);
    const fixtures = allFixtures.filter(f =>
      allowed.has(f.league?.id) && isAllowedMatch(f, ALLOWED_LEAGUE_IDS)
    );

    if (!fixtures.length) {
      await logCron(0, 0, 'success', `no FT/AET/PEN fixtures after filters (api:${apiTotal})`);
      return res.status(200).json({
        ok: true, dates, api_total: apiTotal, after_filter: 0,
        message: 'No allowed FT/AET/PEN fixtures across 3-day window',
      });
    }

    // Pas 2: identifică fixturile fără date complete (player_stats SAU match_stats)
    const fixtureIds = fixtures.map(f => f.fixture.id);
    const [psRes, msRes] = await Promise.all([
      query('SELECT DISTINCT fixture_id FROM player_stats WHERE fixture_id = ANY($1)', [fixtureIds]),
      query('SELECT DISTINCT fixture_id FROM match_stats  WHERE fixture_id = ANY($1)', [fixtureIds]),
    ]);
    const psSet = new Set(psRes.rows.map(r => r.fixture_id));
    const msSet = new Set(msRes.rows.map(r => r.fixture_id));

    // Re-procesez dacă lipsește oricare. Prioritizez cele cu match_stats lipsă
    // (problema curentă: 89.6% din FT au match_stats lipsă).
    const toProcess = fixtures
      .filter(f => !psSet.has(f.fixture.id) || !msSet.has(f.fixture.id))
      .sort((a, b) => {
        // pri 3 = lipsesc ambele; 2 = doar match_stats; 1 = doar player_stats; 0 = niciuna
        const pri = (f) => (msSet.has(f.fixture.id) ? 0 : 2) + (psSet.has(f.fixture.id) ? 0 : 1);
        return pri(b) - pri(a);
      });

    let totalPlayers = 0, totalMatchStats = 0, totalEvents = 0, totalOdds = 0;
    let psFailed = 0, msFailed = 0, evFailed = 0, oddsFailed = 0;

    await ensureEloTables().catch(() => {});

    for (const fx of toProcess) {
      const fixtureId  = fx.fixture.id;
      const homeTeamId = fx.teams?.home?.id;

      // ELO incremental (idempotent prin elo_applied) — non-blocking.
      try { await updateEloForFixture(fx); } catch (_) {}

      try { totalPlayers    += await collectFixture(fixtureId); }
      catch (e) { psFailed++; console.error('collectFixture error:', fixtureId, e.message); }

      try { totalMatchStats += await collectMatchStats(fixtureId, homeTeamId); }
      catch (e) { msFailed++; console.error('collectMatchStats error:', fixtureId, e.message); }

      try { totalEvents     += await collectMatchEvents(fixtureId); }
      catch (e) { evFailed++; }

      try { totalOdds       += await collectOdds(fixtureId); }
      catch (e) { oddsFailed++; }

      await sleep(200);
    }

    const failNote = (psFailed || msFailed || evFailed || oddsFailed)
      ? `failed ps:${psFailed} ms:${msFailed} ev:${evFailed} odds:${oddsFailed}`
      : null;
    await logCron(toProcess.length, totalPlayers, 'success', failNote);
    return res.status(200).json({
      ok: true,
      dates,
      api_total:    apiTotal,
      after_filter: fixtures.length,
      processed:    toProcess.length,
      skipped:      fixtures.length - toProcess.length,
      players:      totalPlayers,
      match_stats:  totalMatchStats,
      events:       totalEvents,
      odds:         totalOdds,
      fails: { player_stats: psFailed, match_stats: msFailed, events: evFailed, odds: oddsFailed },
    });
  } catch (e) {
    await logCron(0, 0, 'error', e.message);
    return res.status(500).json({ error: e.message });
  }
}
