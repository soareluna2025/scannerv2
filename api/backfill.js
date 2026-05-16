// api/backfill.js
// Backfill date istorice 2022-2025 pentru toate ligile.
// Planul pe faze (una pe zi, la 03:00 UTC / 05:00 Germania):
//   fixtures_2022 → fixtures_2023 → fixtures_2024 → fixtures_2025
//   → players → h2h → standings → teams_stats → done
// Rate limit: oprire la 95.000 req/zi (limita API = 100.000)

import { query } from './db.js';
import { ALLOWED_LEAGUE_IDS } from './leagues.js';

const SEASONS    = [2022, 2023, 2024, 2025];
const LEAGUE_IDS = [...ALLOWED_LEAGUE_IDS];
const BASE_URL   = 'https://v3.football.api-sports.io';
const STOP_AT    = 95_000;
const DELAY_MS   = 200;

const PHASES = [
  'fixtures_2022', 'fixtures_2023', 'fixtures_2024', 'fixtures_2025',
  'players', 'h2h', 'standings', 'teams_stats',
];

const PHASE_SEASON = {
  fixtures_2022: 2022, fixtures_2023: 2023,
  fixtures_2024: 2024, fixtures_2025: 2025,
};

let reqCount = 0;
let running  = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg)  { console.log(`[backfill] ${new Date().toISOString()} ${msg}`); }
function key()     {
  return process.env.API_FOOTBALL_KEY
      || process.env.FOOTBALL_API_KEY
      || process.env.APIFOOTBALL_KEY;
}

async function apiFetch(endpoint) {
  const k = key();
  if (!k) throw new Error('API_FOOTBALL_KEY missing');
  await sleep(DELAY_MS);
  let res = await fetch(`${BASE_URL}${endpoint}`, { headers: { 'x-apisports-key': k } });
  reqCount++;
  if (res.status === 429) {
    log(`429 rate-limit pe ${endpoint} — aștept 60s`);
    await sleep(60_000);
    res = await fetch(`${BASE_URL}${endpoint}`, { headers: { 'x-apisports-key': k } });
    reqCount++;
  }
  return res.json();
}

// ── Phase tracking ────────────────────────────────────────────────────────────

function phaseIndex(status) {
  if (status === 'pending') return -1;
  if (status === 'done')    return PHASES.length;
  const i = PHASES.indexOf(status);
  return i === -1 ? -1 : i;
}

async function getCurrentPhase() {
  const { rows } = await query('SELECT status FROM backfill_progress');
  for (let i = 0; i < PHASES.length; i++) {
    if (rows.some(r => phaseIndex(r.status) < i)) return PHASES[i];
  }
  return null; // toate ligile done
}

async function getLeaguesForPhase(phase) {
  const idx = PHASES.indexOf(phase);
  const { rows } = await query(
    "SELECT league_id, status FROM backfill_progress WHERE status != 'done'"
  );
  return rows.filter(r => phaseIndex(r.status) < idx).map(r => r.league_id);
}

// ── Faza: fixtures ────────────────────────────────────────────────────────────

async function runFixtures(leagueId, season) {
  const data = await apiFetch(`/fixtures?league=${leagueId}&season=${season}`);
  const list = data.response || [];
  let count = 0;
  for (const fx of list) {
    const { fixture: f, teams: t, goals: g, score: sc } = fx;
    await query(
      `INSERT INTO fixtures_history
         (fixture_id, league_id, season,
          home_team_id, home_team_name, away_team_id, away_team_name,
          home_goals, away_goals, home_ht, away_ht, status_short, match_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (fixture_id) DO NOTHING`,
      [
        f.id, leagueId, season,
        t.home.id, t.home.name, t.away.id, t.away.name,
        g.home, g.away,
        sc?.halftime?.home ?? null, sc?.halftime?.away ?? null,
        f.status?.short || null, f.date || null,
      ]
    );
    // Upsert echipe
    for (const tm of [t.home, t.away]) {
      await query(
        `INSERT INTO teams (team_id, name, logo)
         VALUES ($1,$2,$3)
         ON CONFLICT (team_id) DO UPDATE SET
           name=EXCLUDED.name, logo=EXCLUDED.logo, updated_at=NOW()`,
        [tm.id, tm.name, tm.logo || null]
      );
    }
    count++;
  }
  return count;
}

// ── Faza: players ─────────────────────────────────────────────────────────────

async function runPlayers(leagueId) {
  let total = 0;
  for (const season of SEASONS) {
    if (reqCount >= STOP_AT) break;
    let page = 1;
    while (reqCount < STOP_AT) {
      const data = await apiFetch(`/players?league=${leagueId}&season=${season}&page=${page}`);
      const players    = data.response || [];
      const totalPages = data.paging?.total || 1;
      for (const entry of players) {
        const pl   = entry.player || {};
        const stat = (entry.statistics || [])[0] || {};
        await query(
          `INSERT INTO players_season
             (player_id, team_id, league_id, season, player_name,
              nationality, position, age, appearances, lineups,
              minutes, goals, assists, yellow_cards, red_cards, rating)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (player_id, league_id, season) DO UPDATE SET
             team_id=EXCLUDED.team_id, appearances=EXCLUDED.appearances,
             lineups=EXCLUDED.lineups, minutes=EXCLUDED.minutes,
             goals=EXCLUDED.goals, assists=EXCLUDED.assists,
             yellow_cards=EXCLUDED.yellow_cards, red_cards=EXCLUDED.red_cards,
             rating=EXCLUDED.rating, updated_at=NOW()`,
          [
            pl.id, stat.team?.id || null, leagueId, season,
            pl.name || null, pl.nationality || null,
            stat.games?.position || null, pl.age || null,
            stat.games?.appearences || 0, stat.games?.lineups || 0,
            stat.games?.minutes    || 0,
            stat.goals?.total      || 0, stat.goals?.assists || 0,
            stat.cards?.yellow     || 0, stat.cards?.red     || 0,
            stat.games?.rating ? parseFloat(stat.games.rating) : null,
          ]
        );
        total++;
      }
      if (page >= totalPages) break;
      page++;
    }
  }
  return total;
}

// ── Faza: h2h ─────────────────────────────────────────────────────────────────

async function runH2H(leagueId) {
  const { rows: pairs } = await query(
    `SELECT DISTINCT
       LEAST(home_team_id, away_team_id)    AS t1,
       GREATEST(home_team_id, away_team_id) AS t2
     FROM fixtures_history
     WHERE league_id = $1
       AND home_team_id IS NOT NULL AND away_team_id IS NOT NULL`,
    [leagueId]
  );
  let count = 0;
  for (const { t1, t2 } of pairs) {
    if (reqCount >= STOP_AT) break;
    const data    = await apiFetch(`/fixtures/headtohead?h2h=${t1}-${t2}&last=20`);
    const matches = data.response || [];
    for (const m of matches) {
      const hid = m.teams?.home?.id;
      const aid = m.teams?.away?.id;
      if (!hid || !aid) continue;
      await query(
        `INSERT INTO h2h
           (team1_id, team2_id, fixture_id,
            home_team_id, away_team_id, home_goals, away_goals,
            match_date, league_id, season)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (team1_id, team2_id, fixture_id) DO UPDATE SET
           home_goals=EXCLUDED.home_goals, away_goals=EXCLUDED.away_goals`,
        [
          Math.min(hid, aid), Math.max(hid, aid), m.fixture.id,
          hid, aid,
          m.goals?.home ?? null, m.goals?.away ?? null,
          m.fixture.date || null,
          m.league?.id || leagueId,
          m.league?.season || null,
        ]
      );
      count++;
    }
  }
  return count;
}

// ── Faza: standings ───────────────────────────────────────────────────────────

async function runStandings(leagueId) {
  let count = 0;
  for (const season of SEASONS) {
    if (reqCount >= STOP_AT) break;
    const data = await apiFetch(`/standings?league=${leagueId}&season=${season}`);
    const rows = data.response?.[0]?.league?.standings?.[0] || [];
    for (const row of rows) {
      await query(
        `INSERT INTO standings
           (league_id, season, team_id, team_name, team_logo,
            rank, points, goals_diff, form, status, description,
            played, win, draw, lose, goals_for, goals_against)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (league_id, season, team_id) DO UPDATE SET
           rank=EXCLUDED.rank, points=EXCLUDED.points,
           goals_diff=EXCLUDED.goals_diff, form=EXCLUDED.form,
           played=EXCLUDED.played, win=EXCLUDED.win,
           draw=EXCLUDED.draw, lose=EXCLUDED.lose,
           goals_for=EXCLUDED.goals_for, goals_against=EXCLUDED.goals_against,
           updated_at=NOW()`,
        [
          leagueId, season,
          row.team.id, row.team.name, row.team.logo || null,
          row.rank, row.points, row.goalsDiff || 0,
          row.form || null, row.status || null, row.description || null,
          row.all?.played || 0,
          row.all?.win    || 0, row.all?.draw || 0, row.all?.lose || 0,
          row.all?.goals?.for     || 0,
          row.all?.goals?.against || 0,
        ]
      );
      count++;
    }
  }
  return count;
}

// ── Faza: teams_stats ─────────────────────────────────────────────────────────

async function runTeamsStats(leagueId) {
  const { rows: teamRows } = await query(
    `SELECT DISTINCT home_team_id AS tid FROM fixtures_history WHERE league_id=$1 AND home_team_id IS NOT NULL
     UNION
     SELECT DISTINCT away_team_id         FROM fixtures_history WHERE league_id=$1 AND away_team_id IS NOT NULL`,
    [leagueId]
  );
  let count = 0;
  for (const { tid } of teamRows) {
    for (const season of SEASONS) {
      if (reqCount >= STOP_AT) break;
      const data = await apiFetch(`/teams/statistics?team=${tid}&league=${leagueId}&season=${season}`);
      const s = data.response;
      if (!s) continue;
      const fx = s.fixtures || {};
      const g  = s.goals    || {};
      const cs = s.clean_sheet || {};
      await query(
        `INSERT INTO teams_stats
           (team_id, league_id, season, form,
            played_home, played_away, played_total,
            wins_home,   wins_away,   wins_total,
            draws_home,  draws_away,  draws_total,
            loses_home,  loses_away,  loses_total,
            goals_for_home, goals_for_away, goals_for_total,
            goals_against_home, goals_against_away, goals_against_total,
            avg_goals_for, avg_goals_against,
            clean_sheets_home, clean_sheets_away, clean_sheets_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
         ON CONFLICT (team_id, league_id, season) DO UPDATE SET
           form=EXCLUDED.form, played_total=EXCLUDED.played_total,
           wins_total=EXCLUDED.wins_total, goals_for_total=EXCLUDED.goals_for_total,
           goals_against_total=EXCLUDED.goals_against_total, updated_at=NOW()`,
        [
          tid, leagueId, season, s.form || null,
          fx.played?.home  || 0, fx.played?.away  || 0, fx.played?.total  || 0,
          fx.wins?.home    || 0, fx.wins?.away    || 0, fx.wins?.total    || 0,
          fx.draws?.home   || 0, fx.draws?.away   || 0, fx.draws?.total   || 0,
          fx.loses?.home   || 0, fx.loses?.away   || 0, fx.loses?.total   || 0,
          g.for?.total?.home     || 0, g.for?.total?.away     || 0, g.for?.total?.total     || 0,
          g.against?.total?.home || 0, g.against?.total?.away || 0, g.against?.total?.total || 0,
          parseFloat(g.for?.average?.total)     || null,
          parseFloat(g.against?.average?.total) || null,
          cs.home || 0, cs.away || 0, cs.total || 0,
        ]
      );
      count++;
    }
  }
  return count;
}

// ── Progress updates ──────────────────────────────────────────────────────────

async function markDone(leagueId, phase, fCount, pCount) {
  const isLast  = phase === PHASES.at(-1);
  const newStat = isLast ? 'done' : phase;
  await query(
    `UPDATE backfill_progress
     SET status=$1, fixtures_processed=fixtures_processed+$2,
         players_upserted=players_upserted+$3, last_run=NOW(), error_msg=NULL
     WHERE league_id=$4`,
    [newStat, fCount, pCount, leagueId]
  );
}

async function markError(leagueId, errMsg) {
  await query(
    `UPDATE backfill_progress SET status='error', last_run=NOW(), error_msg=$1
     WHERE league_id=$2`,
    [String(errMsg).slice(0, 500), leagueId]
  );
}

async function logCron(phase, leagues, fixtures, players, status, errMsg, durMs) {
  try {
    await query(
      `INSERT INTO cron_logs (job_name, fixtures_processed, players_upserted, status, error_msg, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [`backfill:${phase}`, fixtures, players, status, errMsg || null, durMs]
    );
  } catch (_) {}
}

// ── Exported: init ────────────────────────────────────────────────────────────

export async function initBackfillProgress() {
  try {
    for (const leagueId of LEAGUE_IDS) {
      await query(
        `INSERT INTO backfill_progress (league_id, status, fixtures_processed, players_upserted)
         VALUES ($1,'pending',0,0)
         ON CONFLICT (league_id) DO NOTHING`,
        [leagueId]
      );
    }
    log(`backfill_progress: ${LEAGUE_IDS.length} ligi inițializate`);
  } catch (e) {
    log(`initBackfillProgress error: ${e.message}`);
  }
}

// ── Exported: daily run ───────────────────────────────────────────────────────

export async function runDailyBackfill() {
  if (running) { log('deja rulează — skip'); return; }
  running  = true;
  reqCount = 0;
  const t0 = Date.now();

  try {
    const phase = await getCurrentPhase();
    if (!phase) { log('toate ligile done — backfill complet'); running = false; return; }

    const leagues = await getLeaguesForPhase(phase);
    log(`faza: ${phase} | ligi rămase: ${leagues.length}`);

    let totalFx = 0, totalPl = 0, done = 0;

    for (const leagueId of leagues) {
      if (reqCount >= STOP_AT) { log(`limită ${reqCount} req atinsă — oprire`); break; }

      try {
        let fCount = 0, pCount = 0;

        if (PHASE_SEASON[phase]) {
          fCount = await runFixtures(leagueId, PHASE_SEASON[phase]);
          log(`fixtures ${PHASE_SEASON[phase]} liga ${leagueId}: ${fCount} meciuri | req ${reqCount}`);
        } else if (phase === 'players') {
          pCount = await runPlayers(leagueId);
          log(`players liga ${leagueId}: ${pCount} jucători | req ${reqCount}`);
        } else if (phase === 'h2h') {
          fCount = await runH2H(leagueId);
          log(`h2h liga ${leagueId}: ${fCount} intrări | req ${reqCount}`);
        } else if (phase === 'standings') {
          fCount = await runStandings(leagueId);
          log(`standings liga ${leagueId}: ${fCount} rânduri | req ${reqCount}`);
        } else if (phase === 'teams_stats') {
          fCount = await runTeamsStats(leagueId);
          log(`teams_stats liga ${leagueId}: ${fCount} rânduri | req ${reqCount}`);
        }

        await markDone(leagueId, phase, fCount, pCount);
        totalFx += fCount;
        totalPl += pCount;
        done++;
      } catch (e) {
        log(`liga ${leagueId} eroare: ${e.message}`);
        await markError(leagueId, e.message);
      }
    }

    const dur    = Date.now() - t0;
    const status = reqCount >= STOP_AT ? 'stopped_limit' : 'ok';
    log(`terminat: ${done} ligi, ${totalFx} fixtures, ${totalPl} jucători, ${reqCount} req, ${dur}ms`);
    await logCron(phase, done, totalFx, totalPl, status, null, dur);
  } catch (e) {
    log(`eroare fatală: ${e.message}`);
    await logCron('error', 0, 0, 0, 'error', e.message, Date.now() - t0);
  } finally {
    running = false;
  }
}
