import { calcPoisson6x6, parseOddsItem, calcEV } from './calc-utils.js';
import { query } from './db.js';
import { logPrediction } from './log-prediction.js';
import { fetchApiFootball } from './utils/fetch-api.js';

const PRE_MATCH_STATUSES = new Set(['NS']);
const LIVE_STATUSES = new Set(['1H','HT','2H','ET','BT','P','LIVE','INT']);
const FINISHED_STATUSES = new Set(['FT','AET','PEN','SUSP','ABD','AWD','WO']);

// Referee impact: home bias + cards markets adjustments
async function getRefereeImpact(refereeName) {
  const impact = { homeWin: 1, over25: 1, cards: 1, over35Cards: null, source: [] };
  if (!refereeName) return impact;
  try {
    const { rows } = await query(`
      SELECT total_matches, home_win_rate, avg_yellow_cards, pct_over_3_5_cards, pct_over_4_5_cards, card_bias_score
      FROM referee_stats WHERE referee_name = $1
    `, [refereeName]);
    const r = rows[0];
    if (!r || Number(r.total_matches) < 5) return impact;
    // Home bias adjustment
    if (r.home_win_rate != null) {
      if (Number(r.home_win_rate) > 55) {
        impact.homeWin *= 1.10;
        impact.source.push(`home_bias(${Number(r.home_win_rate).toFixed(0)}%)`);
      } else if (Number(r.home_win_rate) < 35) {
        impact.homeWin *= 0.90;
        impact.source.push(`away_bias(${Number(r.home_win_rate).toFixed(0)}%)`);
      }
    }
    // Cards prediction (separate market)
    if (r.pct_over_3_5_cards != null) {
      impact.over35Cards = +Number(r.pct_over_3_5_cards).toFixed(0);
      impact.source.push(`o3.5cards(${impact.over35Cards}%)`);
    }
    // Card-happy referee → mai multe stop-uri → mai putin Over goluri
    if (r.avg_yellow_cards > 5) {
      impact.over25 *= 0.95;
      impact.source.push(`cardy_ref(${Number(r.avg_yellow_cards).toFixed(1)})`);
    }
  } catch (e) { /* silent */ }
  return impact;
}

// Coach impact: returneaza multiplicatori pe baza style + tenure
async function getCoachImpact(homeTeamId, awayTeamId) {
  const impact = { homeAttack: 1, awayAttack: 1, homeDefense: 1, awayDefense: 1, source: [] };
  try {
    const { rows } = await query(
      'SELECT team_id, style, tenure_days, avg_goals_for, avg_goals_against FROM coach_stats WHERE team_id = ANY($1)',
      [[homeTeamId, awayTeamId]]
    );
    for (const c of rows) {
      const isHome = c.team_id === homeTeamId;
      const style = c.style || '';
      const tenure = Number(c.tenure_days) || 0;
      const gf = Number(c.avg_goals_for) || 0;
      const ga = Number(c.avg_goals_against) || 0;

      // Style multipliers
      if (style === 'attack') {
        if (isHome) { impact.homeAttack *= 1.08; impact.source.push('home_attack_coach'); }
        else { impact.awayAttack *= 1.08; impact.source.push('away_attack_coach'); }
      } else if (style === 'defensive') {
        if (isHome) { impact.homeDefense *= 0.90; impact.source.push('home_def_coach'); }
        else { impact.awayDefense *= 0.90; impact.source.push('away_def_coach'); }
      }

      // Tenure bonus: coach nou (<30 zile) are impact minor
      if (tenure < 30 && tenure > 0) {
        if (isHome) impact.homeAttack *= 0.97;
        else impact.awayAttack *= 0.97;
        impact.source.push(`${isHome?'home':'away'}_new_coach(${tenure}d)`);
      }

      // Goals stats override daca avem date concrete
      if (gf > 0) {
        const attackMult = Math.min(1.15, Math.max(0.85, gf / 1.3));
        const defenseMult = Math.min(1.15, Math.max(0.85, 1.1 / Math.max(ga, 0.5)));
        if (isHome) {
          impact.homeAttack  = +(impact.homeAttack  * attackMult).toFixed(3);
          impact.homeDefense = +(impact.homeDefense * defenseMult).toFixed(3);
        } else {
          impact.awayAttack  = +(impact.awayAttack  * attackMult).toFixed(3);
          impact.awayDefense = +(impact.awayDefense * defenseMult).toFixed(3);
        }
        impact.source.push(`${isHome?'home':'away'}_coach_stats`);
      }
    }
  } catch (_) {}
  return impact;
}

async function getFormFromDB(teamId) {
  try {
    const r = await query(
      `SELECT home_team_id, away_team_id, home_goals, away_goals
       FROM fixtures_history
       WHERE (home_team_id = $1 OR away_team_id = $1)
         AND status_short = 'FT'
         AND home_goals IS NOT NULL
       ORDER BY match_date DESC
       LIMIT 10`,
      [teamId]
    );
    return r.rows;
  } catch (_) { return []; }
}

async function getH2HFromDB(hId, aId) {
  try {
    const r = await query(
      `SELECT home_team_id, away_team_id, home_goals, away_goals
       FROM fixtures_history
       WHERE ((home_team_id=$1 AND away_team_id=$2) OR (home_team_id=$2 AND away_team_id=$1))
         AND status_short='FT' AND home_goals IS NOT NULL
       ORDER BY match_date DESC
       LIMIT 10`,
      [hId, aId]
    );
    return r.rows;
  } catch (_) { return []; }
}

function h2hToFixtures(rows) {
  return rows.map(r => ({
    teams: {
      home: { id: r.home_team_id },
      away: { id: r.away_team_id },
    },
    goals: {
      home: r.home_goals,
      away: r.away_goals,
    },
  }));
}

async function getTeamStrengths(hId, aId) {
  try {
    const r = await query(
      `WITH ranked AS (
         SELECT player_id, team_id, rating, goals, assists, pass_accuracy, shots_on_target,
                ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY fixture_id DESC) AS rn
         FROM player_stats
         WHERE team_id = ANY($1)
       )
       SELECT team_id,
              AVG(rating) AS avg_rating,
              AVG(goals) AS goals_per_game,
              AVG(pass_accuracy) AS avg_pass_acc,
              AVG(shots_on_target) AS avg_sot,
              MAX(goals) AS top_scorer
       FROM ranked
       WHERE rn <= 110
       GROUP BY team_id`,
      [[hId, aId]]
    );
    const map = {};
    for (const row of r.rows) {
      const avgRating  = Number(row.avg_rating)    || 0;
      const goalsPerG  = Number(row.goals_per_game) || 0;
      const avgPassAcc = Number(row.avg_pass_acc)   || 0;
      const avgSOT     = Number(row.avg_sot)        || 0;
      const topScorer  = Number(row.top_scorer)     || 0;
      const strength   =
        (avgRating  / 10 * 100) * 0.35 +
        Math.min(100, goalsPerG * 35) * 0.25 +
        avgPassAcc * 0.20 +
        Math.min(100, avgSOT * 12) * 0.10 +
        Math.min(100, topScorer * 20) * 0.10;
      map[row.team_id] = +strength.toFixed(1);
    }
    return map;
  } catch (_) { return {}; }
}

async function getLeagueStats(lgid) {
  if (!lgid) return null;
  try {
    const { rows } = await query(
      'SELECT * FROM league_stats WHERE league_id = $1 ORDER BY updated_at DESC LIMIT 1',
      [Number(lgid)]
    );
    return rows[0] || null;
  } catch (_) { return null; }
}

async function getRefereeStats(refName) {
  if (!refName) return null;
  try {
    const { rows } = await query(
      'SELECT * FROM referee_stats WHERE referee_name = $1',
      [refName]
    );
    return rows[0] || null;
  } catch (_) { return null; }
}

async function getMatchStatsFromDB(fixtureId) {
  try {
    const r = await query(
      'SELECT * FROM match_stats WHERE fixture_id = $1',
      [fixtureId]
    );
    return r.rows;
  } catch (_) { return []; }
}

async function getVenueForFixture(fixtureId) {
  try {
    const r = await query(
      `SELECT v.altitude, v.city, v.name AS venue_name
       FROM fixtures f
       JOIN venues v ON v.id = f.venue_id
       WHERE f.fixture_id = $1
       LIMIT 1`,
      [fixtureId]
    );
    if (!r.rows.length) {
      const r2 = await query(
        `SELECT v.altitude, v.city, v.name AS venue_name
         FROM fixtures_history fh
         JOIN venues v ON v.id = fh.venue_id
         WHERE fh.fixture_id = $1
         LIMIT 1`,
        [fixtureId]
      );
      return r2.rows[0] || null;
    }
    return r.rows[0];
  } catch (_) { return null; }
}

async function getTeamStatsFromDB(teamId, leagueId) {
  try {
    const r = leagueId
      ? await query(
          `SELECT avg_goals_for, avg_goals_against,
                  wins_home, draws_home, losses_home,
                  wins_away, draws_away, losses_away,
                  form_home, form_away
           FROM teams_stats WHERE team_id = $1 AND league_id = $2
           ORDER BY season DESC LIMIT 1`,
          [teamId, Number(leagueId)]
        )
      : await query(
          `SELECT avg_goals_for, avg_goals_against,
                  wins_home, draws_home, losses_home,
                  wins_away, draws_away, losses_away,
                  form_home, form_away
           FROM teams_stats WHERE team_id = $1
           ORDER BY season DESC LIMIT 1`,
          [teamId]
        );
    return r.rows[0] || null;
  } catch (_) { return null; }
}

async function getOddsFromDB(fixtureId) {
  try {
    const r = await query(
      'SELECT *, bet_name AS market, value_name AS label, value_odd AS odd_value FROM odds WHERE fixture_id = $1 AND bookmaker_id = 8',
      [fixtureId]
    );
    if (r.rows.length > 0) return r.rows;

    // Fallback: prematch_data stocheăză odds ca array [{bookmakers:[{id,name,bets:[{name,values}]}]}]
    const pd = await query(
      `SELECT payload FROM prematch_data WHERE fixture_id = $1 AND data_type = 'odds'
       ORDER BY collected_at DESC LIMIT 1`,
      [fixtureId]
    );
    if (!pd.rows.length) return [];
    const arr = pd.rows[0].payload;
    if (!Array.isArray(arr) || !arr.length) return [];
    const rows = [];
    for (const item of arr) {
      for (const bm of item.bookmakers || []) {
        for (const bet of bm.bets || []) {
          for (const v of bet.values || []) {
            const oddVal = parseFloat(v.odd);
            if (!oddVal) continue;
            rows.push({
              bookmaker_id:   bm.id,
              bookmaker_name: bm.name,
              market:         bet.name,
              label:          v.value,
              odd_value:      oddVal,
            });
          }
        }
      }
    }
    return rows;
  } catch (_) { return []; }
}

async function getInjuriesFromDB(fixtureId) {
  try {
    const r = await query('SELECT * FROM injuries WHERE fixture_id = $1', [fixtureId]);
    if (r.rows.length > 0) return r.rows;

    // Fallback: prematch_data stocheăză injuries ca array JSON brut
    const pd = await query(
      `SELECT payload FROM prematch_data WHERE fixture_id = $1 AND data_type = 'injuries'
       ORDER BY collected_at DESC LIMIT 1`,
      [fixtureId]
    );
    if (!pd.rows.length) return [];
    const arr = pd.rows[0].payload;
    if (!Array.isArray(arr)) return [];
    return arr.map(item => ({
      fixture_id:  fixtureId,
      team_id:     item.team?.id    || null,
      team_name:   item.team?.name  || null,
      player_id:   item.player?.id  || null,
      player_name: item.player?.name || null,
      type:        item.player?.type || null,
      reason:      item.player?.reason || null,
    }));
  } catch (_) { return []; }
}

async function fetchAndStoreInjuries(fixtureId) {
  try {
    // M6: verifica DB înîinte de API — skip dacă există date mai recente de 6h
    const existing = await query(
      `SELECT COUNT(*) AS cnt, MAX(updated_at) AS last_update FROM injuries WHERE fixture_id = $1`,
      [fixtureId]
    );
    const lastUpdate = existing.rows[0]?.last_update;
    if (lastUpdate && new Date(lastUpdate) > new Date(Date.now() - 6 * 60 * 60 * 1000)) return;

    const r = await fetchApiFootball(`/injuries?fixture=${fixtureId}`);
    const data = await r.json();
    const list = data.response || [];
    for (const item of list) {
      await query(
        `INSERT INTO injuries
           (fixture_id, league_id, season, team_id, team_name,
            player_id, player_name, type, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (fixture_id, player_id) DO NOTHING`,
        [
          fixtureId,
          item.league?.id      || null,
          item.league?.season  || null,
          item.team?.id        || null,
          item.team?.name      || null,
          item.player?.id      || null,
          item.player?.name    || null,
          item.player?.type    || null,
          item.player?.reason  || null,
        ]
      );
    }
  } catch (_) {}
}

async function getTeamStatsFromDB(teamId, leagueId) {
  try {
    const r = leagueId
      ? await query(
          `SELECT avg_goals_for, avg_goals_against,
                  wins_home, draws_home, losses_home,
                  wins_away, draws_away, losses_away,
                  form_home, form_away
           FROM teams_stats WHERE team_id = $1 AND league_id = $2
           ORDER BY season DESC LIMIT 1`,
          [teamId, Number(leagueId)]
        )
      : await query(
          `SELECT avg_goals_for, avg_goals_against,
                  wins_home, draws_home, losses_home,
                  wins_away, draws_away, losses_away,
                  form_home, form_away
           FROM teams_stats WHERE team_id = $1
           ORDER BY season DESC LIMIT 1`,
          [teamId]
        );
    return r.rows[0] || null;
  } catch (_) { return null; }
}