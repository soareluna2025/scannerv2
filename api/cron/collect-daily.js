// api/cron/collect-daily.js
// Rulează zilnic la 06:00
// Colectează: standings, leagues, teams pentru toate ligile din whitelist
// + upcoming fixtures pentru azi + următoarele 3 zile (date picker calendar)

import { query } from '../db.js';
import { ALLOWED_LEAGUE_IDS } from '../leagues.js';
import { isAllowedMatch } from '../utils/league-filter.js';
import { fetchApiFootball } from '../utils/fetch-api.js';
import { calcPoisson6x6 } from '../calc-utils.js';
import { seasonForLeague, fallbackSeason } from '../utils/season.js';

const PRIORITY_LEAGUES = [...ALLOWED_LEAGUE_IDS];

// SEASON = DOAR fallback (folosit la batch-ul form_stats, care lucrează pe sezonul
// din fixtures_history). Standings se colectează acum pe sezon DINAMIC per ligă
// (seasonForLeague) — fix pt ligile pe an calendaristic (Brazil 71, MLS 253...).
const SEASON = fallbackSeason();

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

    // UPSERT leagues din metadata fixturilor — ORICE ligă whitelisted cu fixturi
    // capătă rând (inclusiv cupe knockout fără standings, ex. 130 Copa Argentina,
    // pe care bucla de standings le sare). Dedup o dată per ligă (nu per meci).
    // Aceleași coloane ca INSERT-ul din bucla de standings (:294).
    const seenLeagues = new Set();
    for (const m of filtered) {
      const lg = m.league;
      if (!lg?.id || seenLeagues.has(lg.id)) continue;
      seenLeagues.add(lg.id);
      try {
        await query(
          `INSERT INTO leagues (league_id, name, country, logo, active, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (league_id) DO UPDATE SET
             name=EXCLUDED.name, country=EXCLUDED.country,
             logo=EXCLUDED.logo, active=EXCLUDED.active, updated_at=EXCLUDED.updated_at`,
          [lg.id, lg.name, lg.country || null, lg.logo || null, true, new Date().toISOString()]
        );
      } catch (_) { /* continuă — non-fatal */ }
    }

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

// CAZ SPECIAL Cupa Mondială (league_id=1): fetch TOT sezonul 2026 (toate cele ~72+
// meciuri din grupe + knockout pe măsură ce se cunosc), nu doar fereastra de date.
// Așa programul complet (11 iun–19 iul) e mereu în DB. Upsert în fixtures (status NS
// pt viitoare) + salvează logo-ul/steagul fiecărei naționale în teams (pt drapele în
// hub). DOAR pentru league 1 — nu atinge colectarea celorlalte ligi.
async function collectWorldCupSchedule(stats) {
  let fxList = [];
  try {
    fxList = await fetchAPI(`/fixtures?league=1&season=2026&timezone=UTC`);
  } catch (e) {
    stats.errors.push(`worldcup fixtures: ${e.message}`);
    return;
  }
  let upserted = 0;
  for (const m of fxList) {
    try {
      // Salvează echipele naționale cu logo (crest/steag) — sursa drapelelor.
      for (const side of ['home', 'away']) {
        const t = m.teams?.[side];
        if (t?.id) {
          await query(
            `INSERT INTO teams (team_id, name, logo, national, country, updated_at)
             VALUES ($1,$2,$3,TRUE,$4,NOW())
             ON CONFLICT (team_id) DO UPDATE SET
               name=EXCLUDED.name,
               logo=COALESCE(EXCLUDED.logo, teams.logo),
               national=TRUE, updated_at=NOW()`,
            [t.id, t.name, t.logo || null, t.name || null]
          ).catch(() => {});
        }
      }
      await query(
        `INSERT INTO fixtures
           (fixture_id, league_id, season, round, home_team_id, home_team_name,
            away_team_id, away_team_name, status_short, status_long, match_date, updated_at)
         VALUES ($1,1,2026,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
         ON CONFLICT (fixture_id) DO UPDATE SET
           round=EXCLUDED.round,
           home_team_id=EXCLUDED.home_team_id, home_team_name=EXCLUDED.home_team_name,
           away_team_id=EXCLUDED.away_team_id, away_team_name=EXCLUDED.away_team_name,
           status_short=EXCLUDED.status_short, status_long=EXCLUDED.status_long,
           match_date=EXCLUDED.match_date, updated_at=NOW()`,
        [
          m.fixture?.id,
          m.league?.round || null,
          m.teams?.home?.id, m.teams?.home?.name,
          m.teams?.away?.id, m.teams?.away?.name,
          m.fixture?.status?.short || 'NS',
          m.fixture?.status?.long  || 'Not Started',
          m.fixture?.date,
        ]
      );
      upserted++;
    } catch (_) { /* skip punctual */ }
  }
  stats.worldcup_fixtures = upserted;
}

// Pre-calculează predicții Poisson PURE pentru meciurile NS azi+3, din date
// deja existente în DB (form_stats + standings) → ZERO calls API.
// Scop: modalul afișează λ + probabilități instant, fără să aștepte enrich-ul
// on-demand. NU folosește calcConfidencePreMatch — doar Poisson 6x6 standard.
async function computeUpcomingPredictions(stats) {
  // Coloana `source` — idempotent (același pattern ca goals_diff la standings).
  try { await query(`ALTER TABLE predictions ADD COLUMN IF NOT EXISTS source TEXT`); } catch (_) {}

  let rows = [];
  try {
    const r = await query(
      `SELECT f.fixture_id, f.league_id, f.season,
              f.home_team_id, f.away_team_id, f.home_team_name, f.away_team_name, f.match_date,
              fh.avg_scored_home AS h_sc, fh.avg_conceded_home AS h_co,
              fa.avg_scored_away AS a_sc, fa.avg_conceded_away AS a_co,
              sh.goals_for AS h_gf, sh.goals_against AS h_ga, sh.played AS h_pl,
              sa.goals_for AS a_gf, sa.goals_against AS a_ga, sa.played AS a_pl
         FROM fixtures f
         LEFT JOIN form_stats fh ON fh.team_id=f.home_team_id AND fh.league_id=f.league_id AND fh.season=f.season
         LEFT JOIN form_stats fa ON fa.team_id=f.away_team_id AND fa.league_id=f.league_id AND fa.season=f.season
         LEFT JOIN standings  sh ON sh.team_id=f.home_team_id AND sh.league_id=f.league_id AND sh.season=f.season
         LEFT JOIN standings  sa ON sa.team_id=f.away_team_id AND sa.league_id=f.league_id AND sa.season=f.season
        WHERE f.status_short='NS'
          AND f.match_date >= NOW() - INTERVAL '6 hours'
          AND f.match_date <= NOW() + INTERVAL '4 days'`
    );
    rows = r.rows;
  } catch (e) {
    stats.errors.push(`predictions-select: ${e.message}`);
    return;
  }

  // Rata de goluri: preferă forma recentă (>0), apoi media sezonală (standings),
  // altfel null (date necunoscute pentru echipa respectivă).
  const rate = (formAvg, total, played) => {
    const v = formAvg != null ? Number(formAvg) : null;
    if (v != null && v > 0) return v;
    const p = Number(played) || 0;
    if (p > 0 && total != null) return Number(total) / p;
    return null;
  };
  const r2 = v => Math.round(v * 1000) / 1000;
  let upserted = 0;

  for (const row of rows) {
    const hS = rate(row.h_sc, row.h_gf, row.h_pl);
    const hC = rate(row.h_co, row.h_ga, row.h_pl);
    const aS = rate(row.a_sc, row.a_gf, row.a_pl);
    const aC = rate(row.a_co, row.a_ga, row.a_pl);
    // Sare peste meciuri fără NICIO dată reală pentru vreo echipă (evită 1.2/1.2 garbage).
    const homeHas = hS != null || hC != null;
    const awayHas = aS != null || aC != null;
    if (!homeHas || !awayHas) continue;

    const HS = hS != null ? hS : 1.2, HC = hC != null ? hC : 1.2;
    const AS = aS != null ? aS : 1.2, AC = aC != null ? aC : 1.2;
    let lambdaHome = (HS + AC) / 2;
    let lambdaAway = (AS + HC) / 2;
    // Clamp defensiv (în spiritul clamp-ului de scoruri extreme din calcPoisson).
    lambdaHome = Math.min(Math.max(lambdaHome, 0.1), 5);
    lambdaAway = Math.min(Math.max(lambdaAway, 0.1), 5);
    const mx = calcPoisson6x6(lambdaHome, lambdaAway);

    try {
      await query(
        `INSERT INTO predictions
           (fixture_id, home_team, away_team, league_id, match_date,
            lambda_home, lambda_away, lambda_total,
            over15_prob, over25_prob, gg_prob,
            home_win_prob, draw_prob, away_win_prob,
            source, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'collect-daily',NOW())
         ON CONFLICT (fixture_id) DO UPDATE SET
           lambda_home=EXCLUDED.lambda_home, lambda_away=EXCLUDED.lambda_away,
           lambda_total=EXCLUDED.lambda_total,
           over15_prob=EXCLUDED.over15_prob, over25_prob=EXCLUDED.over25_prob,
           gg_prob=EXCLUDED.gg_prob, home_win_prob=EXCLUDED.home_win_prob,
           draw_prob=EXCLUDED.draw_prob, away_win_prob=EXCLUDED.away_win_prob,
           source='collect-daily', updated_at=NOW()`,
        [
          row.fixture_id, row.home_team_name, row.away_team_name, row.league_id, row.match_date,
          r2(lambdaHome), r2(lambdaAway), r2(lambdaHome + lambdaAway),
          mx.over15Prob, mx.over25Prob, mx.ggProb,
          mx.homeWin, mx.draw, mx.awayWin,
        ]
      );
      upserted++;
    } catch (_) { /* skip eșecuri punctuale (FK etc.) */ }
  }
  stats.predictions_scanned  = rows.length;
  stats.predictions_upserted = upserted;
}

async function logCron(stats, status, errorMsg) {
  try {
    await Promise.resolve(/* cron_logs → dispecer */);
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

    // Pas 1b — CAZ SPECIAL WC: programul complet league=1 season=2026 (toate meciurile).
    try {
      await collectWorldCupSchedule(stats);
    } catch (e) {
      stats.errors.push(`worldcup: ${e.message}`);
    }

    for (const leagueId of PRIORITY_LEAGUES) {

      try {
        // Sezon DINAMIC per ligă (seasons.current) — corect pt ligi an-calendaristic.
        const lgSeason = await seasonForLeague(leagueId);
        const standings = await fetchAPI(`/standings?league=${leagueId}&season=${lgSeason}`);
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

        // Standings poate avea mai multe sub-array-uri (câte unul per grupă, ex.
        // Cupa Mondială: Group A..L). Iterăm TOATE, nu doar [0], și capturăm
        // `row.group` în group_name (necesare pt hub-ul WC / orice ligă cu grupe).
        const rows = (standings[0]?.league?.standings || []).flat().filter(Boolean);

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
                goals_for, goals_against, goals_diff, played, win, draw, lose, form, group_name, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
             ON CONFLICT (league_id, season, team_id) DO UPDATE SET
               team_name=EXCLUDED.team_name, rank=EXCLUDED.rank, points=EXCLUDED.points,
               goals_for=EXCLUDED.goals_for, goals_against=EXCLUDED.goals_against,
               goals_diff=EXCLUDED.goals_diff, played=EXCLUDED.played,
               win=EXCLUDED.win, draw=EXCLUDED.draw, lose=EXCLUDED.lose,
               form=EXCLUDED.form, group_name=EXCLUDED.group_name, updated_at=EXCLUDED.updated_at`,
            [
              leagueId, lgSeason, row.team.id, row.team.name, row.rank, row.points,
              row.all?.goals?.for     || 0,
              row.all?.goals?.against || 0,
              row.goalsDiff           || 0,
              row.all?.played         || 0,
              row.all?.win            || 0,
              row.all?.draw           || 0,
              row.all?.lose           || 0,
              row.form || null,
              row.group || null,
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

    // Predicții Poisson pre-calculate pentru NS azi+3 (după form_stats fresh, 0 API)
    try {
      await computeUpcomingPredictions(stats);
    } catch (e) {
      stats.errors.push(`predictions: ${e.message}`);
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
