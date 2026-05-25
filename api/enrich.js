import { calcPoisson6x6, parseOddsItem, calcEV } from './calc-utils.js';
import { query } from './db.js';
import { logPrediction } from './log-prediction.js';
import { fetchApiFootball } from './utils/fetch-api.js';

const PRE_MATCH_STATUSES = new Set(['NS']);
const LIVE_STATUSES = new Set(['1H','HT','2H','ET','BT','P','LIVE','INT']);
const FINISHED_STATUSES = new Set(['FT','AET','PEN','SUSP','ABD','AWD','WO']);

// Coach impact: returneaza multiplicatori pe baza style + tenure
// Tenure < 90 zile → bounce effect (+8% offensive). Tenure > 3 ani → veteran stability (+3%).
// Style 'offensive' boost over 2.5. Style 'defensive' boost under + clean sheet.
async function getCoachImpact(teamId) {
  const impact = { over15: 1, over25: 1, gg: 1, source: [] };
  if (!teamId) return impact;
  try {
    const { rows } = await query(`
      SELECT cs.style, cs.tenure_days, cs.avg_goals_for, cs.avg_goals_against,
             cs.clean_sheet_rate, cs.failed_to_score_rate, cs.win_rate, cs.matches
      FROM coach_stats cs
      JOIN coaches c ON c.coach_id = cs.coach_id
      WHERE c.team_id = $1
      ORDER BY cs.updated_at DESC
      LIMIT 1
    `, [teamId]);
    const cs = rows[0];
    if (!cs || cs.matches < 5) return impact;
    // Tenure effect
    if (cs.tenure_days != null) {
      if (cs.tenure_days < 90) {
        impact.over15 *= 1.08; impact.over25 *= 1.10;
        impact.source.push(`coach_new(${cs.tenure_days}d)`);
      } else if (cs.tenure_days > 1095) {
        impact.over15 *= 1.03;
        impact.source.push(`coach_veteran(${Math.round(cs.tenure_days/365)}y)`);
      }
    }
    // Style effect
    if (cs.style === 'offensive') {
      impact.over25 *= 1.12; impact.gg *= 1.08;
      impact.source.push('style_offensive');
    } else if (cs.style === 'open') {
      impact.over25 *= 1.15; impact.gg *= 1.12;
      impact.source.push('style_open');
    } else if (cs.style === 'defensive') {
      impact.over25 *= 0.88; impact.gg *= 0.92;
      impact.source.push('style_defensive');
    } else if (cs.style === 'pragmatic') {
      impact.over15 *= 0.95;
      impact.source.push('style_pragmatic');
    }
  } catch (e) { /* silent */ }
  return impact;
}

// Returneaza multiplicatori pe Over1.5, Over2.5, GG pe baza venue + meteo.
// Default toate la 1.0 (no effect). Apel safe — daca lipsesc date, returneaza neutru.
//
// Bazat pe studii: altitudine > 2000m reduce ~15% intensitatea oaspetilor,
// vant > 30 km/h face long-balls dificile, ploaie intensa creste cards.
async function getVenueAndMeteoImpact(fixtureId, venueId, meteoData) {
  const impact = { over15: 1, over25: 1, gg: 1, cards: 1, source: [] };
  // Venue altitude
  if (venueId) {
    try {
      const { rows } = await query(
        `SELECT altitude_m, surface FROM venues WHERE venue_id = $1`,
        [venueId]
      );
      const v = rows[0];
      if (v) {
        if (v.altitude_m > 2500) {
          impact.over15 *= 0.78; impact.over25 *= 0.70;
          impact.source.push(`altitude_extreme(${v.altitude_m}m)`);
        } else if (v.altitude_m > 2000) {
          impact.over15 *= 0.88; impact.over25 *= 0.82;
          impact.source.push(`altitude_high(${v.altitude_m}m)`);
        } else if (v.altitude_m > 1500) {
          impact.over15 *= 0.94; impact.over25 *= 0.90;
          impact.source.push(`altitude_mid(${v.altitude_m}m)`);
        }
        if (v.surface === 'artificial') {
          impact.over25 *= 1.05;
          impact.source.push('artificial_turf');
        }
      }
    } catch (e) { /* silent */ }
  }
  // Meteo
  if (meteoData) {
    const { temperature, wind_kmh, precipitation_mm } = meteoData;
    if (wind_kmh > 30) {
      impact.over25 *= 0.90; impact.cards *= 1.05;
      impact.source.push(`wind(${Math.round(wind_kmh)}kmh)`);
    }
    if (precipitation_mm > 5) {
      impact.over25 *= 0.92; impact.cards *= 1.20;
      impact.source.push(`rain(${precipitation_mm}mm)`);
    }
    if (temperature > 32) {
      impact.over15 *= 0.92; impact.over25 *= 0.88;
      impact.source.push(`hot(${Math.round(temperature)}C)`);
    }
    if (temperature < 2) {
      impact.over25 *= 0.96;
      impact.source.push(`cold(${Math.round(temperature)}C)`);
    }
  }
  return impact;
}

function calcDynamicLambda(lambdaBase, elapsed, currentGoals, sot) {
  if (!elapsed || elapsed <= 0) return { lambda: lambdaBase, dynamic: false };
  const minutesLeft = Math.max(1, 90 - elapsed);
  const fraction = minutesLeft / 90;
  const shotRate = (sot / Math.max(elapsed, 1)) * 90;
  const intensityFactor = 1 + Math.min(shotRate / 25, 0.4);
  const lambdaRemaining = lambdaBase * fraction * intensityFactor;
  return { lambda: currentGoals + lambdaRemaining, dynamic: true };
}

function calcPoisson(hGames, aGames, h2h, hId, aId, elapsedParam, hgParam, agParam, sothParam, sotaParam, lgHome = 1.2, lgAway = 1.2) {
  const avg = (arr, fn) => arr.length ? arr.reduce((s, m) => s + fn(m), 0) / arr.length : 0;
  const pct = (arr, fn) => arr.length ? Math.round(arr.filter(fn).length / arr.length * 100) : null;

  const homeAvgScored   = avg(hGames, m => (m.teams?.home?.id === hId ? m.goals?.home : m.goals?.away) ?? 0);
  const homeAvgConceded = avg(hGames, m => (m.teams?.home?.id === hId ? m.goals?.away : m.goals?.home) ?? 0);
  const awayAvgScored   = avg(aGames, m => (m.teams?.away?.id === aId ? m.goals?.away : m.goals?.home) ?? 0);
  const awayAvgConceded = avg(aGames, m => (m.teams?.away?.id === aId ? m.goals?.home : m.goals?.away) ?? 0);

  let lambdaHome = hGames.length && aGames.length
    ? (homeAvgScored + awayAvgConceded) / 2
    : lgHome;
  let lambdaAway = hGames.length && aGames.length
    ? (awayAvgScored + homeAvgConceded) / 2
    : lgAway;

  let isDynamic = false;
  const elapsedNum = parseInt(elapsedParam) || 0;
  if (elapsedNum > 0) {
    const dynHome = calcDynamicLambda(lambdaHome, elapsedNum, parseInt(hgParam) || 0, parseInt(sothParam) || 0);
    const dynAway = calcDynamicLambda(lambdaAway, elapsedNum, parseInt(agParam)  || 0, parseInt(sotaParam) || 0);
    lambdaHome = dynHome.lambda;
    lambdaAway = dynAway.lambda;
    isDynamic  = dynHome.dynamic || dynAway.dynamic;
  }

  const lambdaTotal = lambdaHome + lambdaAway;
  const matrix = calcPoisson6x6(lambdaHome, lambdaAway);

  const confidence = (h2h.length >= 8 && hGames.length >= 8 && aGames.length >= 8) ? 'HIGH'
                   : (h2h.length >= 5 && hGames.length >= 5 && aGames.length >= 5) ? 'MED'
                   : 'LOW';

  const r2 = v => Math.round(v * 100) / 100;

  return {
    homeAvgScored:   r2(homeAvgScored),
    homeAvgConceded: r2(homeAvgConceded),
    homeScoreRate:   pct(hGames, m => ((m.teams?.home?.id === hId ? m.goals?.home : m.goals?.away) ?? 0) > 0) ?? Math.round((1 - Math.exp(-lambdaHome)) * 100),
    awayAvgScored:   r2(awayAvgScored),
    awayAvgConceded: r2(awayAvgConceded),
    awayScoreRate:   pct(aGames, m => ((m.teams?.away?.id === aId ? m.goals?.away : m.goals?.home) ?? 0) > 0) ?? Math.round((1 - Math.exp(-lambdaAway)) * 100),
    lambdaHome:      r2(lambdaHome),
    lambdaAway:      r2(lambdaAway),
    lambdaTotal:     r2(lambdaTotal),
    over15Prob:      matrix.over15Prob,
    over25Prob:      matrix.over25Prob,
    ggProb:          matrix.ggProb,
    homeWin:         matrix.homeWin,
    draw:            matrix.draw,
    awayWin:         matrix.awayWin,
    h2hOver15:       pct(h2h, m => ((m.goals?.home ?? 0) + (m.goals?.away ?? 0)) > 1) ?? matrix.over15Prob,
    h2hGG:           pct(h2h, m => (m.goals?.home ?? 0) > 0 && (m.goals?.away ?? 0) > 0) ?? matrix.ggProb,
    h2hSample:       h2h.length,
    confidence,
    isDynamic
  };
}

async function getLeagueStats(lgid) {
  if (!lgid) return null;
  try {
    const r = await query('SELECT * FROM league_stats WHERE league_id = $1', [Number(lgid)]);
    return r.rows[0] || null;
  } catch (_) { return null; }
}

async function getRefereeStats(refName) {
  if (!refName) return null;
  try {
    const r = await query('SELECT * FROM referee_stats WHERE referee_name = $1', [refName]);
    return r.rows[0] || null;
  } catch (_) { return null; }
}

async function getTeamStrengths(hId, aId) {
  try {
    const [rH, rA] = await Promise.all([
      query('SELECT rating, goals, pass_accuracy, shots_on_target FROM player_stats WHERE team_id = $1 ORDER BY fixture_id DESC LIMIT 110', [hId]),
      query('SELECT rating, goals, pass_accuracy, shots_on_target FROM player_stats WHERE team_id = $1 ORDER BY fixture_id DESC LIMIT 110', [aId]),
    ]);
    const dH = rH.rows;
    const dA = rA.rows;

    const calcStr = (rows) => {
      if (!Array.isArray(rows) || rows.length < 10) return null;
      const rated     = rows.filter(r => r.rating);
      const avgRating = rated.length ? rated.reduce((s, r) => s + Number(r.rating), 0) / rated.length : 5;
      const goalsPerGame = rows.reduce((s, r) => s + (r.goals || 0), 0) / rows.length;
      const withPass     = rows.filter(r => r.pass_accuracy != null);
      const avgPassAcc   = withPass.length ? withPass.reduce((s, r) => s + Number(r.pass_accuracy), 0) / withPass.length : 50;
      const avgSot       = rows.reduce((s, r) => s + (r.shots_on_target || 0), 0) / rows.length;
      const topScorer    = Math.max(...rows.map(r => r.goals || 0), 0);
      const topScorerForm = Math.min(100, topScorer * 20);
      return Math.round(
        (avgRating / 10 * 100) * 0.35 +
        Math.min(100, goalsPerGame * 35) * 0.25 +
        avgPassAcc * 0.20 +
        Math.min(100, avgSot * 12) * 0.10 +
        topScorerForm * 0.10
      );
    };

    return { home: calcStr(dH), away: calcStr(dA) };
  } catch (_) {
    return { home: null, away: null };
  }
}

function calcConfidence(result, oddsRaw, liveStats, teamStrengths, evData) {
  const score1 = result.over15Prob ?? 50;
  const elapsed  = liveStats?.elapsed ?? 0;
  const sotTotal = liveStats?.sot     ?? null;
  const ycTotal  = liveStats?.yc      ?? 0;

  const homeAvg = result.homeAvgScored || 1.2;
  const awayAvg = result.awayAvgScored || 1.0;
  const score2 = Math.min(100, (homeAvg + awayAvg) / 3.5 * 100);

  const score3 = result.h2hOver15 != null ? result.h2hOver15 : score1;

  // Layer 4 — Live: xG + SOT + DA (fără podea 50)
  let score4 = score1; // fallback pentru pre-meci
  if (liveStats) {
    const sot = liveStats.sot || 0;
    const xg  = liveStats.xg  || 0;
    const da  = liveStats.da  || 0;
    if (sot === 0 && elapsed > 10) {
      score4 = 20; // niciun șut pe poartă după min 10 — semnal slab
    } else {
      score4 = Math.min(100, xg * 25 + sot * 3 + da * 0.5);
    }
  }

  // Layer 5 — EV: folosim evData calculat deja (elimină hardcodarea la 50%)
  let score5 = null;
  let bestMarket = null, bestCota = null, bestEV = null;
  if (evData?.hasOdds) {
    const candidates = [
      { name: 'Over 1.5', ev: evData.evOver15, cota: evData.cotaOver15 },
      { name: 'GG',       ev: evData.evGG,     cota: evData.cotaGG },
      { name: '1 Gazde',  ev: evData.evHome,   cota: evData.cotaHome },
      { name: 'X Egal',   ev: evData.evDraw,   cota: evData.cotaDraw },
      { name: '2 Oasp.',  ev: evData.evAway,   cota: evData.cotaAway },
    ].filter(c => c.ev != null && c.cota != null && c.cota >= 1.20)
     .sort((a, b) => b.ev - a.ev);

    if (candidates.length) {
      const best = candidates[0];
      bestMarket = best.name;
      bestCota   = best.cota;
      if (best.ev > 0) {
        score5 = Math.min(100, best.ev * 300);
        bestEV = '+' + Math.round(best.ev * 100) + '%';
      } else {
        score5 = Math.max(10, 50 + Math.round(best.ev * 100));
      }
    }
  } else if (oddsRaw) {
    // fallback: calcul direct când evData nu e disponibil
    const markets = [
      { name: 'Over 1.5', cota: oddsRaw.cotaOver15, prob: result.over15Prob / 100 },
      { name: 'GG',       cota: oddsRaw.cotaGG,     prob: result.ggProb     / 100 },
      { name: '1 Gazde',  cota: oddsRaw.cotaHome,   prob: result.homeWin    / 100 },
      { name: 'X Egal',   cota: oddsRaw.cotaDraw,   prob: result.draw       / 100 },
      { name: '2 Oasp.',  cota: oddsRaw.cotaAway,   prob: result.awayWin    / 100 },
    ].filter(m => m.cota >= 1.20 && m.prob != null);

    if (markets.length) {
      const evMarkets = markets.map(m => ({ ...m, ev: m.prob * m.cota - 1 }))
        .sort((a, b) => b.ev - a.ev);
      const best = evMarkets[0];
      bestMarket = best.name;
      bestCota   = best.cota;
      if (best.ev > 0) {
        score5 = Math.min(100, best.ev * 300);
        bestEV = '+' + Math.round(best.ev * 100) + '%';
      } else {
        score5 = Math.max(10, 50 + Math.round(best.ev * 100));
      }
    }
  }

  const scores = [score1, score2, score3, score4, score5];
  const alignedCount = scores.filter(s => s > 60).length;
  const score6 = (alignedCount / 5) * 100;

  let score7 = null;
  let teamStrengthHome = null, teamStrengthAway = null;
  if (teamStrengths && (teamStrengths.home != null || teamStrengths.away != null)) {
    teamStrengthHome = teamStrengths.home;
    teamStrengthAway = teamStrengths.away;
    const h = teamStrengths.home || 50;
    const a = teamStrengths.away || 50;
    score7 = Math.round((h + a) / 2);
  }

  const layers = [
    { score: score1, w: 0.22 },
    { score: score2, w: 0.20 },
    { score: score3, w: 0.10 },
    { score: score4, w: 0.15 },
    { score: score5, w: 0 }, // EV — exclus din scor (informativ in breakdown)
    { score: score6, w: 0.05 },
    { score: score7, w: 0.20 },
  ].filter(l => l.score !== null).filter(l => l.w > 0);
  const totalW = layers.reduce((s, l) => s + l.w, 0);
  const confidenceScore = Math.round(layers.reduce((s, l) => s + l.score * (l.w / totalW), 0));
  const hasStr = score7 != null;

  let adjustedScore = confidenceScore;
  // Penalizare date insuficiente la minute mici
  if (elapsed > 0 && elapsed < 15) {
    adjustedScore = Math.round(adjustedScore * 0.85);
  } else if (elapsed >= 15 && elapsed < 30 && sotTotal !== null && sotTotal === 0) {
    adjustedScore = Math.round(adjustedScore * 0.80);
  }
  if (elapsed >= 45 && sotTotal !== null && sotTotal === 0) {
    adjustedScore = Math.max(10, adjustedScore - 20);
  }
  if (ycTotal >= 2) {
    adjustedScore = Math.max(10, adjustedScore - 10);
  }
  adjustedScore = Math.max(5, Math.min(100, adjustedScore));

  return {
    confidenceScore: adjustedScore,
    breakdown: {
      poisson:      Math.round(score1),
      forma:        Math.round(score2),
      h2h:          Math.round(score3),
      live:         Math.round(score4),
      ev:           Math.round(score5),
      consistenta:  Math.round(score6),
      ...(hasStr ? { putereEchipe: score7 } : {}),
    },
    teamStrengthHome,
    teamStrengthAway,
    bestMarket,
    bestCota,
    bestEV,
  };
}

// --- PostgreSQL data helpers ---

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
    return r.rows.map(row => ({
      teams: { home: { id: row.home_team_id }, away: { id: row.away_team_id } },
      goals: { home: row.home_goals ?? 0, away: row.away_goals ?? 0 },
    }));
  } catch (_) { return []; }
}

async function getH2HFromDB(homeId, awayId) {
  try {
    const r = await query(
      'SELECT * FROM h2h WHERE (home_team_id = $1 AND away_team_id = $2) OR (home_team_id = $2 AND away_team_id = $1) ORDER BY match_date DESC LIMIT 10',
      [homeId, awayId]
    );
    return r.rows;
  } catch (_) { return []; }
}

async function getOddsFromDB(fixtureId) {
  try {
    const r = await query(
      'SELECT *, bet_name AS market, value_name AS label, value_odd AS odd_value FROM odds WHERE fixture_id = $1 AND bookmaker_id = 8',
      [fixtureId]
    );
    return r.rows;
  } catch (_) { return []; }
}

async function getInjuriesFromDB(fixtureId) {
  try {
    const r = await query('SELECT * FROM injuries WHERE fixture_id = $1', [fixtureId]);
    return r.rows;
  } catch (_) { return []; }
}

async function fetchAndStoreInjuries(fixtureId) {
  try {
    // M6: verifica DB înainte de API — skip dacă există date mai recente de 6h
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
                  clean_sheets_home, clean_sheets_away,
                  played_home, played_away
           FROM teams_stats WHERE team_id = $1 AND league_id = $2
           ORDER BY season DESC LIMIT 1`,
          [teamId, Number(leagueId)]
        )
      : await query(
          `SELECT avg_goals_for, avg_goals_against,
                  clean_sheets_home, clean_sheets_away,
                  played_home, played_away
           FROM teams_stats WHERE team_id = $1
           ORDER BY season DESC LIMIT 1`,
          [teamId]
        );
    return r.rows[0] || null;
  } catch (_) { return null; }
}

async function getVenueForFixture(fixtureId) {
  try {
    const r = await query(
      `SELECT payload FROM prematch_data
       WHERE fixture_id = $1 AND data_type = 'fixture'
       ORDER BY collected_at DESC LIMIT 1`,
      [fixtureId]
    );
    if (!r.rows.length) return null;
    const payload = r.rows[0].payload;
    const venueId = Array.isArray(payload) ? payload[0]?.fixture?.venue?.id : null;
    if (!venueId) return null;
    const v = await query(
      'SELECT surface, latitude, longitude, altitude_m, climate_zone, capacity FROM venues WHERE venue_id = $1',
      [venueId]
    );
    return v.rows[0] || null;
  } catch (_) { return null; }
}

async function getMatchStatsFromDB(fixtureId) {
  if (!fixtureId) return [];
  try {
    const r = await query(
      'SELECT team_id, expected_goals AS xg, shots_on_goal AS shots_on_target FROM match_stats WHERE fixture_id = $1',
      [fixtureId]
    );
    return r.rows;
  } catch (_) { return []; }
}

// Transform h2h rows → API-Football-like format expected by calcPoisson
function h2hToFixtures(rows) {
  return rows.map(row => ({
    goals: { home: row.home_goals ?? 0, away: row.away_goals ?? 0 },
  }));
}

// Transform flat odds rows → parseOddsItem-compatible structure
function oddsRowsToItem(rows) {
  if (!rows.length) return null;
  const betsMap = {};
  for (const row of rows) {
    if (!betsMap[row.market]) betsMap[row.market] = [];
    betsMap[row.market].push({ value: row.label, odd: String(row.odd_value) });
  }
  return {
    bookmakers: [{
      id:   rows[0].bookmaker_id,
      name: rows[0].bookmaker_name,
      bets: Object.entries(betsMap).map(([name, values]) => ({ name, values })),
    }],
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  const { h, a, fid, hn, an, lg, lgid, dt, br, elapsed, hg, ag, soth, sota, ref, status_short } = req.query;
  if (!h || !a) return res.status(400).json({ error: 'Parametri h si a sunt necesari' });

  const hId      = Number(h);
  const aId      = Number(a);
  const hdr      = { 'x-apisports-key': key };

  try {
    // --- Batch 1: DB queries + team strengths + injuries + match_stats + venue in parallel ---
    const [sbHForm, sbAForm, sbH2H, sbOddsRows, teamStrengths, injuries, matchStats, leagueStats, refereeStats, venueInfo] = await Promise.all([
      getFormFromDB(hId),
      getFormFromDB(aId),
      getH2HFromDB(hId, aId),
      fid ? getOddsFromDB(Number(fid)) : Promise.resolve([]),
      getTeamStrengths(hId, aId),
      fid ? getInjuriesFromDB(Number(fid)) : Promise.resolve([]),
      fid ? getMatchStatsFromDB(Number(fid)) : Promise.resolve([]),
      getLeagueStats(lgid),
      getRefereeStats(ref || null),
      fid ? getVenueForFixture(Number(fid)) : Promise.resolve(null),
    ]);

    // --- Batch 2: API-Football fallbacks only where DB had insufficient data ---
    const needHForm = sbHForm.length  < 3;
    const needAForm = sbAForm.length  < 3;
    const needH2H   = sbH2H.length    < 3;
    const needOdds  = fid && sbOddsRows.length === 0;

    const [apiFbHForm, apiFbAForm, apiFbH2H, apiFbOdds] = await Promise.all([
      needHForm ? fetchApiFootball(`/fixtures?team=${h}&last=20&status=FT`).then(r => r.json()) : null,
      needAForm ? fetchApiFootball(`/fixtures?team=${a}&last=20&status=FT`).then(r => r.json()) : null,
      needH2H   ? fetchApiFootball(`/fixtures/headtohead?h2h=${h}-${a}&last=10`).then(r => r.json()) : null,
      needOdds  ? fetchApiFootball(`/odds?fixture=${fid}`).then(r => r.json()) : null,
    ]);

    // Resolve final datasets
    const hGames = needHForm ? (apiFbHForm?.response || []).slice(0, 10) : sbHForm;
    const aGames = needAForm ? (apiFbAForm?.response || []).slice(0, 10) : sbAForm;
    const h2h = needH2H
      ? (apiFbH2H?.response || []).slice(0, 10)
      : h2hToFixtures(sbH2H);

    // teams_stats fallback when form still insufficient after API
    const formInsufficient = hGames.length < 3 || aGames.length < 3;
    const [tsH, tsA] = formInsufficient
      ? await Promise.all([
          getTeamStatsFromDB(hId, lgid),
          getTeamStatsFromDB(aId, lgid),
        ])
      : [null, null];

    // Resolve odds
    let oddsRaw = null;
    if (!needOdds && sbOddsRows.length > 0) {
      oddsRaw = parseOddsItem(oddsRowsToItem(sbOddsRows));
    } else if (needOdds && apiFbOdds) {
      const item = (apiFbOdds.response || [])[0];
      if (item) oddsRaw = parseOddsItem(item);

      // League-level fallback
      if (!oddsRaw && lgid) {
        try {
          const r5 = await fetchApiFootball(`/odds?league=${lgid}&season=${new Date().getFullYear()}`);
          const d5 = await r5.json();
          const item2 = (d5.response || []).find(x => x.fixture?.id === Number(fid));
          if (item2) oddsRaw = parseOddsItem(item2);
        } catch (_) {}
      }
    }

    // --- Calculations ---
    const lgHome = parseFloat(leagueStats?.avg_home_goals) || 1.2;
    const lgAway = parseFloat(leagueStats?.avg_away_goals) || 1.2;
    const result = calcPoisson(hGames, aGames, h2h, hId, aId, elapsed, hg, ag, soth, sota, lgHome, lgAway);

    // teams_stats lambda override — priority 2 (between form_stats and league_stats)
    if (formInsufficient && (tsH || tsA)) {
      const tsHScored   = tsH ? +(tsH.avg_goals_for)     : null;
      const tsHConceded = tsH ? +(tsH.avg_goals_against) : null;
      const tsAScored   = tsA ? +(tsA.avg_goals_for)     : null;
      const tsAConceded = tsA ? +(tsA.avg_goals_against) : null;
      if (tsHScored != null && tsAConceded != null)
        result.lambdaHome = +((tsHScored + tsAConceded) / 2).toFixed(2);
      if (tsAScored != null && tsHConceded != null)
        result.lambdaAway = +((tsAScored + tsHConceded) / 2).toFixed(2);
      result.lambdaTotal = +(result.lambdaHome + result.lambdaAway).toFixed(2);
      // Recalculate matrix with improved lambdas
      const mx2 = calcPoisson6x6(result.lambdaHome, result.lambdaAway);
      Object.assign(result, {
        over15Prob: mx2.over15Prob, over25Prob: mx2.over25Prob,
        ggProb: mx2.ggProb, homeWin: mx2.homeWin,
        draw: mx2.draw, awayWin: mx2.awayWin,
      });
      // Clean sheets penalty on GG — high CS rate at home/away → harder for opponent to score
      const csRateH = tsH && tsH.played_home > 0 ? tsH.clean_sheets_home / tsH.played_home : 0;
      const csRateA = tsA && tsA.played_away > 0 ? tsA.clean_sheets_away / tsA.played_away : 0;
      if (csRateH > 0.35) result.ggProb = Math.max(0, result.ggProb * (1 - (csRateH - 0.35)));
      if (csRateA > 0.35) result.ggProb = Math.max(0, result.ggProb * (1 - (csRateA - 0.35)));
      result._teamsStatsUsed = true;
    }

    // Venue + altitude + meteo amplificat (Faza 1 Hybrid)
    if (venueInfo) {
      const venueMeteo = result.weather || null;
      const imp = await getVenueAndMeteoImpact(fixtureId, venueId, venueMeteo);
      if (imp.source.length > 0) {
        result.over15Prob = Math.max(0, Math.min(100, result.over15Prob * imp.over15));
        result.over25Prob = Math.max(0, Math.min(100, result.over25Prob * imp.over25));
        result.ggProb    = Math.max(0, Math.min(100, result.ggProb    * imp.gg));
        result._venueMeteoImpact = imp.source.join(',');
      }
      result._venueSurface = venueInfo.surface;
      result._venueAltitude = venueInfo.altitude_m;
    }

    // Coach impact (Faza 2 Hybrid) — aplicat pentru ambele echipe agregat
    try {
      const homeImp = await getCoachImpact(hId);
      const awayImp = await getCoachImpact(aId);
      // Combina cele 2 cu media geometrica (echivalent multiplicare conservatoare)
      const combine = (a, b) => Math.sqrt(a * b);
      const o15 = combine(homeImp.over15, awayImp.over15);
      const o25 = combine(homeImp.over25, awayImp.over25);
      const ggm = combine(homeImp.gg,     awayImp.gg);
      if (homeImp.source.length || awayImp.source.length) {
        result.over15Prob = Math.max(0, Math.min(100, result.over15Prob * o15));
        result.over25Prob = Math.max(0, Math.min(100, result.over25Prob * o25));
        result.ggProb    = Math.max(0, Math.min(100, result.ggProb    * ggm));
        result._coachImpact = `H:${homeImp.source.join(',')}|A:${awayImp.source.join(',')}`;
      }
    } catch (_) { /* silent */ }

    // Ajustare Over 2.5 bazată pe stilul arbitrului
    if (refereeStats && Number(refereeStats.total_matches) >= 5) {
      if (refereeStats.referee_style === 'open')
        result.over25Prob = Math.min(100, result.over25Prob + 5);
      else if (refereeStats.referee_style === 'closed')
        result.over25Prob = Math.max(0, result.over25Prob - 5);
    }

    const evData = calcEV(result, oddsRaw);

    // --- Resolve xG ---
    let xgSource = 'estimated';
    let xgValue  = (parseFloat(soth) || 0) * 0.4 + (parseFloat(sota) || 0) * 0.4;

    if (Array.isArray(matchStats) && matchStats.length) {
      const homeRow = matchStats.find(r => r.team_id === hId && r.xg != null);
      const awayRow = matchStats.find(r => r.team_id === aId && r.xg != null);
      if (homeRow || awayRow) {
        xgValue  = (parseFloat(homeRow?.xg) || 0) + (parseFloat(awayRow?.xg) || 0);
        xgSource = 'postgres';
      }
    }

    const da  = parseInt(req.query.da)  || 0;
    const yc  = parseInt(req.query.yc)  || 0;
    const elapsedNum = parseInt(elapsed) || 0;
    const liveStats = elapsedNum > 0 ? {
      xg:  xgValue,
      sot: (parseInt(soth) || 0) + (parseInt(sota) || 0),
      da, yc, elapsed: elapsedNum,
    } : null;

    const confData = calcConfidence(result, oddsRaw, liveStats, teamStrengths, evData);

    if (elapsed && parseInt(elapsed) > 0) {
      confData.breakdown.xg_source = xgSource;
    }

    // --- Injuries adjustment ---
    if (fid && Array.isArray(injuries) && injuries.length >= 3) {
      let injuryPenalty = 0;
      if (injuries.length >= 8)      injuryPenalty = 15;
      else if (injuries.length >= 5) injuryPenalty = 10;
      else if (injuries.length >= 3) injuryPenalty = 5;
      confData.confidenceScore = Math.max(10, confData.confidenceScore - injuryPenalty);
      confData.breakdown.injuries = {
        layer: 'injuries',
        value: -injuryPenalty,
        note:  `${injuries.length} jucători accidentați`,
      };
    }

    const payload = { ...result, ...evData, ...confData, leagueStats: leagueStats || null, refereeStats: refereeStats || null };

    // Fire-and-forget: colectare injuries + prediction save + pre_match snapshot
    if (fid) {
      fetchAndStoreInjuries(Number(fid));

      // Pre-match snapshot for back-testing (only when not live)
      if (PRE_MATCH_STATUSES.has(status_short) || (!parseInt(elapsed) && !LIVE_STATUSES.has(status_short))) {
        const compositeScore = +(
          payload.over15Prob * 0.40 + payload.ggProb * 0.30 + payload.homeWin * 0.30
        ).toFixed(1);
        query(
          `INSERT INTO pre_match_snapshots
             (fixture_id, home_team_id, away_team_id, lambda_home, lambda_away,
              over15_prob, over25_prob, gg_prob, confidence, odds_snapshot, composite_score)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (fixture_id) DO UPDATE SET
             lambda_home=EXCLUDED.lambda_home, lambda_away=EXCLUDED.lambda_away,
             over15_prob=EXCLUDED.over15_prob, over25_prob=EXCLUDED.over25_prob,
             gg_prob=EXCLUDED.gg_prob, confidence=EXCLUDED.confidence,
             composite_score=EXCLUDED.composite_score`,
          [
            Number(fid), hId, aId,
            payload.lambdaHome, payload.lambdaAway,
            payload.over15Prob, payload.over25Prob, payload.ggProb,
            payload.confidenceScore || null,
            oddsRaw ? JSON.stringify(oddsRaw) : null,
            compositeScore,
          ]
        ).catch(() => {});

        // Log OVER15 prediction for self-learning
        if (payload.over15Prob > 0) {
          logPrediction({
            fixture_id: Number(fid), league_id: lgid ? Number(lgid) : null,
            league_name: lg, home_team: hn, away_team: an, match_date: dt || null,
            minute: parseInt(elapsed) || 0,
            score: elapsed > 0 ? `${parseInt(req.query.hg)||0}-${parseInt(req.query.ag)||0}` : '0-0',
            module: 'OVER15',
            predicted_value: payload.over15Prob, threshold_used: 65,
            lambda_home: payload.lambdaHome, lambda_away: payload.lambdaAway,
            layer1: payload.breakdown?.poisson     ?? null,
            layer2: payload.breakdown?.forma        ?? null,
            layer3: payload.breakdown?.h2h          ?? null,
            layer4: payload.breakdown?.live         ?? null,
            layer5: payload.breakdown?.ev           ?? null,
            layer6: payload.breakdown?.consistenta  ?? null,
            layer7: payload.breakdown?.putereEchipe ?? null,
          }).catch(() => {});
          logPrediction({
            fixture_id: Number(fid), league_id: lgid ? Number(lgid) : null,
            league_name: lg, home_team: hn, away_team: an, match_date: dt || null,
            minute: parseInt(elapsed) || 0,
            score: elapsed > 0 ? `${parseInt(req.query.hg)||0}-${parseInt(req.query.ag)||0}` : '0-0',
            module: 'GG',
            predicted_value: payload.ggProb, threshold_used: 60,
            lambda_home: payload.lambdaHome, lambda_away: payload.lambdaAway,
          }).catch(() => {});
          if (payload.confidenceScore > 0) {
            logPrediction({
              fixture_id: Number(fid), league_id: lgid ? Number(lgid) : null,
              league_name: lg, home_team: hn, away_team: an, match_date: dt || null,
              minute: parseInt(elapsed) || 0,
              module: 'CONFIDENCE',
              predicted_value: payload.confidenceScore, threshold_used: 70,
              lambda_home: payload.lambdaHome, lambda_away: payload.lambdaAway,
              layer1: payload.breakdown?.poisson     ?? null,
              layer2: payload.breakdown?.forma        ?? null,
              layer3: payload.breakdown?.h2h          ?? null,
              layer4: payload.breakdown?.live         ?? null,
              layer5: payload.breakdown?.ev           ?? null,
              layer6: payload.breakdown?.consistenta  ?? null,
              layer7: payload.breakdown?.putereEchipe ?? null,
            }).catch(() => {});
          }
        }
      }

      query(
        `INSERT INTO predictions (fixture_id, home_team, away_team, league_name, league_id, match_date,
          lambda_home, lambda_away, lambda_total, over15_prob, over25_prob, gg_prob,
          home_score_rate, away_score_rate, h2h_over15, confidence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (fixture_id) DO NOTHING`,
        [
          Number(fid), hn || '', an || '', lg || '', lgid ? Number(lgid) : null, dt || null,
          payload.lambdaHome, payload.lambdaAway, payload.lambdaTotal,
          payload.over15Prob, payload.over25Prob, payload.ggProb,
          payload.homeScoreRate, payload.awayScoreRate, payload.h2hOver15,
          payload.confidenceScore || null,
        ]
      ).catch(() => {});
    }

    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
