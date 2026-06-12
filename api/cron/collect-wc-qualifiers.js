// Cron: GET /api/cron/collect-wc-qualifiers
// Colectează fixtures (FT) + standings pentru calificările CM 2026, pe toate
// confederațiile (CAF, AFC, CONCACAF, UEFA, OFC, CONMEBOL). Datele alimentează
// tab-ul CALIFICĂRI din cartonașul Cupa Mondială 2026 (api/worldcup-qualifiers.js).
// Rulare MANUALĂ o singură dată (NU în crontab) — istoricul calificărilor e fix.

import { query } from '../db.js';
import { fetchApiFootball } from '../utils/fetch-api.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const DONE = ['FT', 'AET', 'PEN'];

const WC_QUALIFIERS = [
  // Turneul final CM 2026 (league=1): grupe + „Ranking of third-placed teams".
  // season=2026 EXPLICIT — collect-daily folosește seasonForLeague(1) (API seasons.current,
  // poate ≠2026 în timpul turneului) → rândurile season 2026 rămâneau neîmprospătate.
  { league: 1, season: 2026, name: 'World Cup', confederation: 'World Cup Finals' },
  { league: 29, season: 2023, name: 'CAF', confederation: 'Africa' },
  { league: 30, season: 2022, name: 'AFC', confederation: 'Asia' },
  { league: 30, season: 2026, name: 'AFC', confederation: 'Asia' },
  { league: 31, season: 2022, name: 'CONCACAF', confederation: 'CONCACAF' },
  { league: 31, season: 2026, name: 'CONCACAF', confederation: 'CONCACAF' },
  { league: 32, season: 2024, name: 'UEFA', confederation: 'Europe' },
  { league: 33, season: 2022, name: 'OFC', confederation: 'Oceania' },
  { league: 33, season: 2026, name: 'OFC', confederation: 'Oceania' },
  { league: 34, season: 2022, name: 'CONMEBOL', confederation: 'South America' },
  { league: 34, season: 2026, name: 'CONMEBOL', confederation: 'South America' },
];

async function logCron(status, msg = '') {
  try {
    await Promise.resolve(/* cron_logs → dispecer */);
  } catch (_) {}
}

// Upsert un meci FT în fixtures_history (același format ca collect-national-history).
async function saveFixture(fx) {
  const fid = fx?.fixture?.id;
  const status = fx?.fixture?.status?.short;
  if (!fid || !DONE.includes(status)) return false;
  const hg = fx?.goals?.home;
  const ag = fx?.goals?.away;
  if (hg == null || ag == null) return false;
  await query(
    `INSERT INTO fixtures_history
       (fixture_id, match_date, league_id, season,
        home_team_id, home_team_name, away_team_id, away_team_name,
        home_goals, away_goals, home_ht, away_ht, status_short)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (fixture_id) DO UPDATE SET
       home_goals = EXCLUDED.home_goals,
       away_goals = EXCLUDED.away_goals,
       home_ht    = EXCLUDED.home_ht,
       away_ht    = EXCLUDED.away_ht,
       status_short = EXCLUDED.status_short`,
    [
      fid,
      fx?.fixture?.date || null,
      fx?.league?.id || null,
      fx?.league?.season || (fx?.fixture?.date ? new Date(fx.fixture.date).getFullYear() : null),
      fx?.teams?.home?.id || null, fx?.teams?.home?.name || null,
      fx?.teams?.away?.id || null, fx?.teams?.away?.name || null,
      hg, ag,
      fx?.score?.halftime?.home ?? null,
      fx?.score?.halftime?.away ?? null,
      status,
    ]
  );
  return true;
}

// Upsert un rând de clasament (echipa întâi pt FK, apoi standings).
async function saveStanding(leagueId, season, row) {
  if (!row?.team?.id) return false;
  await query(
    `INSERT INTO teams (team_id, name, logo, updated_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (team_id) DO UPDATE SET
       name=EXCLUDED.name, logo=EXCLUDED.logo, updated_at=EXCLUDED.updated_at`,
    [row.team.id, row.team.name, row.team.logo || null, new Date().toISOString()]
  );
  await query(
    `INSERT INTO standings
       (league_id, season, rank, team_id, team_name, team_logo,
        points, goals_diff, group_name, played, win, draw, lose,
        goals_for, goals_against, form, status, description, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (league_id, season, team_id, COALESCE(group_name, '')) DO UPDATE SET
       rank=EXCLUDED.rank, team_name=EXCLUDED.team_name, team_logo=EXCLUDED.team_logo,
       points=EXCLUDED.points, goals_diff=EXCLUDED.goals_diff, group_name=EXCLUDED.group_name,
       played=EXCLUDED.played, win=EXCLUDED.win, draw=EXCLUDED.draw, lose=EXCLUDED.lose,
       goals_for=EXCLUDED.goals_for, goals_against=EXCLUDED.goals_against,
       form=EXCLUDED.form, status=EXCLUDED.status, description=EXCLUDED.description,
       updated_at=NOW()`,
    [
      leagueId, season, row.rank, row.team.id, row.team.name, row.team.logo || null,
      row.points, row.goalsDiff || 0, row.group || null,
      row.all?.played || 0, row.all?.win || 0, row.all?.draw || 0, row.all?.lose || 0,
      row.all?.goals?.for || 0, row.all?.goals?.against || 0,
      row.form || null, row.status || null, row.description || null,
      new Date().toISOString(),
    ]
  );
  return true;
}

export default async function handler(req, res) {
  let leaguesProcessed = 0;
  let fixturesUpserted = 0;
  let standingsUpserted = 0;
  const errors = [];

  try {
    for (const q of WC_QUALIFIERS) {
      // A) FIXTURES
      try {
        const r = await fetchApiFootball(`/fixtures?league=${q.league}&season=${q.season}&status=FT`);
        const d = await r.json();
        for (const fx of (d.response || [])) {
          try { if (await saveFixture(fx)) fixturesUpserted++; }
          catch (_) { /* skip fixture punctual */ }
        }
      } catch (e) {
        errors.push(`fixtures L${q.league}/${q.season}: ${e.message}`);
      }
      await sleep(300);

      // B) STANDINGS
      try {
        const r = await fetchApiFootball(`/standings?league=${q.league}&season=${q.season}`);
        const d = await r.json();
        const blocks = d.response || [];
        const rows = (blocks[0]?.league?.standings || []).flat().filter(Boolean);
        for (const row of rows) {
          try { if (await saveStanding(q.league, q.season, row)) standingsUpserted++; }
          catch (_) { /* skip rând punctual */ }
        }
      } catch (e) {
        errors.push(`standings L${q.league}/${q.season}: ${e.message}`);
      }
      await sleep(300);

      leaguesProcessed++;
    }

    const errNote = errors.length ? errors.slice(0, 10).join(' | ') : null;
    await logCron(errors.length ? 'error' : 'success',
      `leagues:${leaguesProcessed} fixtures:${fixturesUpserted} standings:${standingsUpserted}${errNote ? ' | ' + errNote : ''}`);
    return res.status(200).json({
      ok: true,
      leagues_processed: leaguesProcessed,
      fixtures_upserted: fixturesUpserted,
      standings_upserted: standingsUpserted,
      errors,
    });
  } catch (e) {
    await logCron('error', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
