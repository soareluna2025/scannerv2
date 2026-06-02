// Cron/admin: GET /api/cron/extract-team?team_id=<id>&season=<an>
// Extragere ȚINTITĂ pe O SINGURĂ echipă (ca backfill, dar pt o echipă):
//   a) /teams?id        → upsert teams
//   b) /players (paginat)→ players_season (REUTILIZEAZĂ collectTeamSeason din backfill-players)
//   c) /fixtures?team    → fixtures_history (același upsert ca backfill istoric)
//   d) /leagues?team + /teams/statistics → teams_stats (tabel existent)
// Toate idempotente (ON CONFLICT DO UPDATE). Status pollable prin app_settings
// 'extract_team_status' (JSON) — exact pattern-ul cardului BACKFILL JUCĂTORI.
// NU atinge scoring/NGP/whitelist/freeze — pură colectare.

import { query } from '../db.js';
import { fetchApiFootball } from '../utils/fetch-api.js';
import { collectTeamSeason } from './backfill-players.js';
import enrichHandler from '../enrich.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

let running = false; // anti-concurență per proces

async function ensureSettings() {
  await query(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMP DEFAULT NOW())`).catch(() => {});
}
async function setStatus(obj) {
  try {
    await query(`INSERT INTO app_settings (key, value) VALUES ('extract_team_status', $1)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [JSON.stringify(obj)]);
  } catch (_) {}
}
async function getStatus() {
  try {
    const r = await query(`SELECT value FROM app_settings WHERE key='extract_team_status'`);
    return r.rows[0]?.value ? JSON.parse(r.rows[0].value) : null;
  } catch { return null; }
}
async function logCron(status, msg = '') {
  try { await query(`INSERT INTO cron_logs (job_name, status, error_msg) VALUES ('extract-team', $1, $2)`, [status, msg || null]); }
  catch (_) {}
}

// (a) teams — upsert (nume, țară, logo, founded, venue).
async function extractTeamInfo(teamId) {
  const r = await fetchApiFootball(`/teams?id=${teamId}`);
  const d = await r.json();
  const t = d.response?.[0]?.team;
  const v = d.response?.[0]?.venue;
  if (!t?.id) return null;
  await query(
    `INSERT INTO teams (team_id, name, country, founded, national, logo, venue_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (team_id) DO UPDATE SET
       name=EXCLUDED.name, country=EXCLUDED.country, founded=EXCLUDED.founded,
       national=EXCLUDED.national, logo=COALESCE(EXCLUDED.logo, teams.logo),
       venue_id=EXCLUDED.venue_id, updated_at=NOW()`,
    [t.id, t.name, t.country || null, t.founded || null, !!t.national, t.logo || null, v?.id || null]
  ).catch(() => {});
  return t.name;
}

// (c) fixtures_history — același upsert ca backfill istoric (doar meciuri cu scor).
async function extractFixtures(teamId, season) {
  const r = await fetchApiFootball(`/fixtures?team=${teamId}&season=${season}`);
  const d = await r.json();
  let n = 0;
  for (const fx of (d.response || [])) {
    const fid = fx?.fixture?.id;
    const hg = fx?.goals?.home, ag = fx?.goals?.away;
    if (!fid || hg == null || ag == null) continue;  // fără scor → nu e istoric util
    await query(
      `INSERT INTO fixtures_history
         (fixture_id, league_id, season, home_team_id, home_team_name,
          away_team_id, away_team_name, match_date, status_short, home_goals, away_goals)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (fixture_id) DO UPDATE SET
         league_id=EXCLUDED.league_id, season=EXCLUDED.season,
         home_team_id=EXCLUDED.home_team_id, home_team_name=EXCLUDED.home_team_name,
         away_team_id=EXCLUDED.away_team_id, away_team_name=EXCLUDED.away_team_name,
         match_date=EXCLUDED.match_date, status_short=EXCLUDED.status_short,
         home_goals=EXCLUDED.home_goals, away_goals=EXCLUDED.away_goals`,
      [
        fid, fx?.league?.id || null, fx?.league?.season || season || null,
        fx?.teams?.home?.id || null, fx?.teams?.home?.name || null,
        fx?.teams?.away?.id || null, fx?.teams?.away?.name || null,
        fx?.fixture?.date || null, fx?.fixture?.status?.short || 'FT', hg, ag,
      ]
    ).catch(() => {});
    n++;
  }
  return n;
}

// (d) statistici echipă — ligile sezonului → /teams/statistics → teams_stats (tabel existent).
async function extractTeamStats(teamId, season) {
  let leagues = [];
  try {
    const lr = await fetchApiFootball(`/leagues?team=${teamId}&season=${season}`);
    const ld = await lr.json();
    leagues = (ld.response || []).map(x => x.league?.id).filter(Boolean);
  } catch (_) {}
  let done = 0;
  for (const L of leagues) {
    try {
      const sr = await fetchApiFootball(`/teams/statistics?league=${L}&team=${teamId}&season=${season}`);
      const sd = await sr.json();
      const s = sd.response;
      if (!s?.league?.id) continue;
      const g = (o, k) => (o && o[k] != null ? Number(o[k]) : null);
      await query(
        `INSERT INTO teams_stats
           (team_id, league_id, season, form,
            played_home, played_away, played_total,
            wins_home, wins_away, wins_total,
            draws_home, draws_away, draws_total,
            loses_home, loses_away, loses_total,
            goals_for_home, goals_for_away, goals_for_total,
            goals_against_home, goals_against_away, goals_against_total,
            avg_goals_for, avg_goals_against,
            clean_sheets_home, clean_sheets_away, clean_sheets_total, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,NOW())
         ON CONFLICT (team_id, league_id, season) DO UPDATE SET
           form=EXCLUDED.form,
           played_home=EXCLUDED.played_home, played_away=EXCLUDED.played_away, played_total=EXCLUDED.played_total,
           wins_home=EXCLUDED.wins_home, wins_away=EXCLUDED.wins_away, wins_total=EXCLUDED.wins_total,
           draws_home=EXCLUDED.draws_home, draws_away=EXCLUDED.draws_away, draws_total=EXCLUDED.draws_total,
           loses_home=EXCLUDED.loses_home, loses_away=EXCLUDED.loses_away, loses_total=EXCLUDED.loses_total,
           goals_for_home=EXCLUDED.goals_for_home, goals_for_away=EXCLUDED.goals_for_away, goals_for_total=EXCLUDED.goals_for_total,
           goals_against_home=EXCLUDED.goals_against_home, goals_against_away=EXCLUDED.goals_against_away, goals_against_total=EXCLUDED.goals_against_total,
           avg_goals_for=EXCLUDED.avg_goals_for, avg_goals_against=EXCLUDED.avg_goals_against,
           clean_sheets_home=EXCLUDED.clean_sheets_home, clean_sheets_away=EXCLUDED.clean_sheets_away, clean_sheets_total=EXCLUDED.clean_sheets_total,
           updated_at=NOW()`,
        [
          teamId, s.league.id, season, s.form || null,
          g(s.fixtures?.played, 'home'), g(s.fixtures?.played, 'away'), g(s.fixtures?.played, 'total'),
          g(s.fixtures?.wins, 'home'), g(s.fixtures?.wins, 'away'), g(s.fixtures?.wins, 'total'),
          g(s.fixtures?.draws, 'home'), g(s.fixtures?.draws, 'away'), g(s.fixtures?.draws, 'total'),
          g(s.fixtures?.loses, 'home'), g(s.fixtures?.loses, 'away'), g(s.fixtures?.loses, 'total'),
          g(s.goals?.for?.total, 'home'), g(s.goals?.for?.total, 'away'), g(s.goals?.for?.total, 'total'),
          g(s.goals?.against?.total, 'home'), g(s.goals?.against?.total, 'away'), g(s.goals?.against?.total, 'total'),
          s.goals?.for?.average?.total != null ? parseFloat(s.goals.for.average.total) : null,
          s.goals?.against?.average?.total != null ? parseFloat(s.goals.against.average.total) : null,
          g(s.clean_sheet, 'home'), g(s.clean_sheet, 'away'), g(s.clean_sheet, 'total'),
        ]
      ).catch(() => {});
      done++;
    } catch (_) {}
    await sleep(200);
  }
  return { leagues: leagues.length, statsUpserted: done };
}

// RE-ENRICH ȚINTIT: recalculează predicțiile DOAR pt meciurile VIITOARE (NS) ale echipei.
// Reutilizează EXACT nucleul de compute-and-save per fixture (enrich handler) — NU
// reimplementează scorurile. Apelează FORȚAT (force=1) → ocolește cache-ul (filtrul
// „are nevoie/nu e stale"). Atinge DOAR fixtures NS cu match_date >= now().
export async function reEnrichTeam(teamId) {
  let rows = [];
  try {
    const r = await query(
      `SELECT fixture_id, league_id, home_team_id, home_team_name,
              away_team_id, away_team_name, match_date, status_short
         FROM fixtures
        WHERE (home_team_id = $1 OR away_team_id = $1)
          AND status_short = 'NS'
          AND match_date >= NOW()
        ORDER BY match_date ASC`, [teamId]);
    rows = r.rows;
  } catch (_) { return 0; }

  let done = 0;
  for (const f of rows) {
    // Mock req/res — apel programatic al handler-ului de enrich (compute + save predictions).
    const req = {
      method: 'GET',
      query: {
        h: String(f.home_team_id), a: String(f.away_team_id),
        fid: String(f.fixture_id),
        hn: f.home_team_name || '', an: f.away_team_name || '',
        lgid: f.league_id != null ? String(f.league_id) : '',
        dt: f.match_date ? new Date(f.match_date).toISOString() : '',
        status_short: f.status_short || 'NS',
        force: '1',                 // ocolește cache → re-enrich efectiv
      },
    };
    const res = {
      setHeader() {}, status() { return this; }, json() { return this; }, end() { return this; },
    };
    try { await enrichHandler(req, res); done++; }
    catch (e) { console.error(`[extract-team] reEnrich ${f.fixture_id}: ${e.message}`); }
    await sleep(200);   // rate-limit tehnic (enrich poate atinge API)
  }
  return done;
}

async function runExtract(teamId, season) {
  running = true;
  const st = { running: true, step: 'start', team_name: null, season, team_id: teamId,
               players: 0, fixtures: 0, stats_leagues: 0, done: false, error: null };
  await setStatus(st);

  // a) teams
  try { st.step = 'teams'; await setStatus(st); st.team_name = await extractTeamInfo(teamId); }
  catch (e) { st.error = `teams: ${e.message}`; }
  await setStatus(st);

  // b) jucători (REUTILIZEAZĂ collectTeamSeason — include tratarea player_id null reparată)
  try {
    st.step = 'players'; await setStatus(st);
    const n = await collectTeamSeason(teamId, season);
    st.players = n === -1 ? 0 : n;
  } catch (e) { st.error = (st.error ? st.error + ' | ' : '') + `players: ${e.message}`; }
  await setStatus(st);

  // c) meciuri
  try { st.step = 'fixtures'; await setStatus(st); st.fixtures = await extractFixtures(teamId, season); }
  catch (e) { st.error = (st.error ? st.error + ' | ' : '') + `fixtures: ${e.message}`; }
  await setStatus(st);

  // d) statistici echipă
  try {
    st.step = 'stats'; await setStatus(st);
    const r = await extractTeamStats(teamId, season);
    st.stats_leagues = r.leagues;
    st.stats_upserted = r.statsUpserted;
    st.stats_table = 'teams_stats';
  } catch (e) { st.error = (st.error ? st.error + ' | ' : '') + `stats: ${e.message}`; }
  await setStatus(st);

  // e) RE-ENRICH meciuri viitoare (aplică datele imediat în predicții)
  try {
    st.step = 'reenrich'; await setStatus(st);
    st.reenriched = await reEnrichTeam(teamId);
  } catch (e) { st.error = (st.error ? st.error + ' | ' : '') + `reenrich: ${e.message}`; }

  st.step = 'done'; st.running = false; st.done = true;
  await setStatus(st);
  await logCron(st.error ? 'error' : 'success',
    `team:${st.team_name || teamId} s:${season} players:${st.players} fixtures:${st.fixtures} statsLg:${st.stats_leagues} reenrich:${st.reenriched || 0}${st.error ? ' | ' + st.error : ''}`);
  running = false;
}

// Rulează DOAR re-enrich (fără re-extragere date din API) — trigger de sine stătător.
async function runReEnrichOnly(teamId) {
  running = true;
  const st = { running: true, step: 'reenrich', team_id: teamId, reenrich_only: true,
               players: 0, fixtures: 0, stats_leagues: 0, reenriched: 0, done: false, error: null };
  await setStatus(st);
  try { st.reenriched = await reEnrichTeam(teamId); }
  catch (e) { st.error = `reenrich: ${e.message}`; }
  st.step = 'done'; st.running = false; st.done = true;
  await setStatus(st);
  await logCron(st.error ? 'error' : 'success', `reenrich-only team:${teamId} reenrich:${st.reenriched}${st.error ? ' | ' + st.error : ''}`);
  running = false;
}

export default async function handler(req, res) {
  await ensureSettings();

  if (req.query?.status === '1') {
    return res.status(200).json({ ok: true, status: await getStatus() });
  }

  const teamId = Number(req.query?.team_id);
  if (!teamId) return res.status(400).json({ error: 'team_id required' });

  if (running) return res.status(200).json({ ok: true, already_running: true, status: await getStatus() });

  // Trigger de sine stătător: DOAR re-enrich, fără re-extragere date din API.
  if (req.query?.reenrich_only === '1') {
    runReEnrichOnly(teamId).catch(e => { console.error('[extract-team] reenrich fatal:', e.message); });
    return res.status(200).json({ ok: true, started: true, reenrich_only: true, team_id: teamId,
      note: 'Re-enrich în fundal. Verifică ?status=1 pentru progres.' });
  }

  const season = Number(req.query?.season);
  if (!season) return res.status(400).json({ error: 'season required (sau folosește reenrich_only=1)' });

  runExtract(teamId, season).catch(e => { console.error('[extract-team] fatal:', e.message); });
  return res.status(200).json({ ok: true, started: true, team_id: teamId, season,
    note: 'Rulează în fundal. Verifică ?status=1 pentru progres.' });
}
