// api/cron/collect-daily.js
// Rulează zilnic la 06:00
// Colectează: standings, leagues, teams pentru toate ligile din whitelist
// + upcoming fixtures pentru azi + următoarele 3 zile (date picker calendar)

import { query } from '../db.js';
import { ALLOWED_LEAGUE_IDS } from '../leagues.js';
import { isAllowedMatch } from '../utils/league-filter.js';
import { fetchApiFootball } from '../utils/fetch-api.js';

const PRIORITY_LEAGUES = [...ALLOWED_LEAGUE_IDS];

// Ligile europene (aug-mai) folosesc sezonul anului precedent în mai-aug
// Dacă suntem în ian-jul → season = anul precedent; aug-dec → anul curent
const _y = new Date().getFullYear();
const _m = new Date().getMonth(); // 0=ian
const SEASON = _m < 7 ? _y - 1 : _y; // înainte de august → sezon precedent

async function fetchAPI(endpoint) {
  const res = await fetchApiFootball(endpoint);
  const data = await res.json();
  return data.response || [];
}

function dateOffsetUTC(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// Colectează meciurile NS pentru azi + următoarele 3 zile.
// Filtrate prin ALLOWED_LEAGUE_IDS + isAllowedMatch (women/youth/Tier3+).
// Upsertate în tabela fixtures (același pattern ca api/today.js).
async function collectUpcomingFixtures(stats) {
  const allowed = new Set([...ALLOWED_LEAGUE_IDS]);
  const offsets = [0, 1, 2, 3];                  // azi + 3 zile înainte
  let totalUpserted = 0;
  let totalScanned  = 0;

  for (const off of offsets) {
    const dt = dateOffsetUTC(off);
    let fxList = [];
    try {
      fxList = await fetchAPI(`/fixtures?date=${dt}&status=NS&timezone=UTC`);
    } catch (e) {
      stats.errors.push(`fixtures ${dt}: ${e.message}`);
      continue;
    }
    totalScanned += fxList.length;

    const filtered = fxList.filter(f =>
      allowed.has(f.league?.id) && isAllowedMatch(f, ALLOWED_LEAGUE_IDS)
    );

    for (const m of filtered) {
      try {
        await query(
          `INSERT INTO fixtures
             (fixture_id, league_id, season, home_team_id, home_team_name,
              away_team_id, away_team_name, status_short, status_long, match_date, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
           ON CONFLICT (fixture_id) DO UPDATE SET
             status_short=EXCLUDED.status_short,
             status_long=EXCLUDED.status_long,
             match_date=EXCLUDED.match_date,
             updated_at=NOW()`,
          [
            m.fixture?.id,
            m.league?.id,
            m.league?.season || new Date(m.fixture?.date || dt).getFullYear(),
            m.teams?.home?.id,
            m.teams?.home?.name,
            m.teams?.away?.id,
            m.teams?.away?.name,
            m.fixture?.status?.short || 'NS',
            m.fixture?.status?.long  || 'Not Started',
            m.fixture?.date,
          ]
        );
        totalUpserted++;
      } catch (e) {
        // continuă peste eșecuri punctuale (FK, etc) — log silent
      }
    }
  }
  stats.upcoming_scanned  = totalScanned;
  stats.upcoming_upserted = totalUpserted;
  stats.upcoming_days     = offsets.length;
}

async function logCron(stats, status, errorMsg) {
  try {
    await query(
      `INSERT INTO cron_logs (job_name, fixtures_processed, players_upserted, status, error_msg)
       VALUES ($1,$2,$3,$4,$5)`,
      ['collect-daily', stats.standings, stats.teams, status, errorMsg || null]
    );
  } catch (_) {}
}

export default async function handler(req, res) {
  const key = process.env.API_FOOTBALL_KEY || process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY;

  if (!key) return res.status(500).json({ error: 'Environment vars lipsa' });

  // Asigură coloana goals_diff există (schema veche are goal_diff fără 's')
  try {
    await query(`ALTER TABLE standings ADD COLUMN IF NOT EXISTS goals_diff INTEGER DEFAULT 0`);
  } catch (e) {
    console.warn('[collect-daily] ALTER TABLE standings goals_diff:', e.message);
  }

  const startTime = Date.now();
  const stats = { leagues: 0, teams: 0, standings: 0, errors: [] };

  try {
    // Pas 1 — upcoming fixtures (azi + 3 zile) → tab PRE-MECI / date picker
    try {
      await collectUpcomingFixtures(stats);
    } catch (e) {
      stats.errors.push(`upcoming: ${e.message}`);
    }

    for (const leagueId of PRIORITY_LEAGUES) {

      try {
        const standings = await fetchAPI(`/standings?league=${leagueId}&season=${SEASON}`);
        if (!standings.length) continue;

        const league = standings[0]?.league;
        if (league) {
          await query(
            `INSERT INTO leagues (league_id, name, country, logo, active, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (league_id) DO UPDATE SET
               name=EXCLUDED.name, country=EXCLUDED.country,
               logo=EXCLUDED.logo, active=EXCLUDED.active, updated_at=EXCLUDED.updated_at`,
            [league.id, league.name, league.country, league.logo || null, true, new Date().toISOString()]
          );
          stats.leagues++;
        }

        const rows = standings[0]?.league?.standings?.[0] || [];

        for (const row of rows) {
          if (!row?.team?.id) continue;

          // Inserăm echipa ÎNAINTE de standings (FK constraint)
          await query(
            `INSERT INTO teams (team_id, name, logo, updated_at)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (team_id) DO UPDATE SET
               name=EXCLUDED.name, logo=EXCLUDED.logo, updated_at=EXCLUDED.updated_at`,
            [row.team.id, row.team.name, row.team.logo || null, new Date().toISOString()]
          );
          stats.teams++;

          await query(
            `INSERT INTO standings
               (league_id, season, team_id, team_name, rank, points,
                goals_for, goals_against, goals_diff, played, win, draw, lose, form, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (league_id, season, team_id) DO UPDATE SET
               team_name=EXCLUDED.team_name, rank=EXCLUDED.rank, points=EXCLUDED.points,
               goals_for=EXCLUDED.goals_for, goals_against=EXCLUDED.goals_against,
               goals_diff=EXCLUDED.goals_diff, played=EXCLUDED.played,
               win=EXCLUDED.win, draw=EXCLUDED.draw, lose=EXCLUDED.lose,
               form=EXCLUDED.form, updated_at=EXCLUDED.updated_at`,
            [
              leagueId, SEASON, row.team.id, row.team.name, row.rank, row.points,
              row.all?.goals?.for     || 0,
              row.all?.goals?.against || 0,
              row.goalsDiff           || 0,
              row.all?.played         || 0,
              row.all?.win            || 0,
              row.all?.draw           || 0,
              row.all?.lose           || 0,
              row.form || null,
              new Date().toISOString(),
            ]
          );
          stats.standings++;
        }
      } catch (e) {
        stats.errors.push(`league ${leagueId}: ${e.message}`);
      }
    }

    // Calculează form_stats pentru toate echipele din sezonul curent (batch SQL)
    try {
      await query(`
        INSERT INTO form_stats
          (team_id, league_id, season, last5_home, last5_away,
           avg_scored_home, avg_conceded_home, avg_scored_away, avg_conceded_away, updated_at)
        WITH home_ranked AS (
          SELECT home_team_id AS team_id, league_id, season,
            home_goals, away_goals, match_date,
            row_number() OVER (PARTITION BY home_team_id, league_id, season ORDER BY match_date DESC) AS rn
          FROM fixtures_history WHERE status_short = 'FT' AND season = $1
        ),
        away_ranked AS (
          SELECT away_team_id AS team_id, league_id, season,
            home_goals, away_goals, match_date,
            row_number() OVER (PARTITION BY away_team_id, league_id, season ORDER BY match_date DESC) AS rn
          FROM fixtures_history WHERE status_short = 'FT' AND season = $1
        ),
        home_agg AS (
          SELECT team_id, league_id, season,
            string_agg(CASE WHEN home_goals > away_goals THEN 'W'
                            WHEN home_goals = away_goals THEN 'D' ELSE 'L' END,
                       '' ORDER BY match_date DESC) AS last5_home,
            AVG(home_goals)::NUMERIC(5,2) AS avg_scored_home,
            AVG(away_goals)::NUMERIC(5,2) AS avg_conceded_home
          FROM home_ranked WHERE rn <= 5
          GROUP BY team_id, league_id, season
        ),
        away_agg AS (
          SELECT team_id, league_id, season,
            string_agg(CASE WHEN away_goals > home_goals THEN 'W'
                            WHEN away_goals = home_goals THEN 'D' ELSE 'L' END,
                       '' ORDER BY match_date DESC) AS last5_away,
            AVG(away_goals)::NUMERIC(5,2) AS avg_scored_away,
            AVG(home_goals)::NUMERIC(5,2) AS avg_conceded_away
          FROM away_ranked WHERE rn <= 5
          GROUP BY team_id, league_id, season
        )
        SELECT
          COALESCE(h.team_id, a.team_id),
          COALESCE(h.league_id, a.league_id),
          COALESCE(h.season, a.season),
          h.last5_home, a.last5_away,
          COALESCE(h.avg_scored_home, 0),
          COALESCE(h.avg_conceded_home, 0),
          COALESCE(a.avg_scored_away, 0),
          COALESCE(a.avg_conceded_away, 0),
          NOW()
        FROM home_agg h
        FULL OUTER JOIN away_agg a
          ON h.team_id = a.team_id AND h.league_id = a.league_id AND h.season = a.season
        ON CONFLICT (team_id, league_id, season) DO UPDATE SET
          last5_home        = EXCLUDED.last5_home,
          last5_away        = EXCLUDED.last5_away,
          avg_scored_home   = EXCLUDED.avg_scored_home,
          avg_conceded_home = EXCLUDED.avg_conceded_home,
          avg_scored_away   = EXCLUDED.avg_scored_away,
          avg_conceded_away = EXCLUDED.avg_conceded_away,
          updated_at        = NOW()
      `, [SEASON]);
      stats.formStats = 'ok';
    } catch (e) {
      console.warn('[collect-daily] form_stats update:', e.message);
    }

    await logCron(stats, 'success', stats.errors.length ? stats.errors.join('; ') : null);

    return res.status(200).json({
      success:     true,
      duration_ms: Date.now() - startTime,
      stats,
    });
  } catch (error) {
    await logCron(stats, 'error', error.message);
    return res.status(500).json({ error: error.message });
  }
}
