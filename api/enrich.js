import { calcPoisson6x6 } from './calc-utils.js';
import { query } from './db.js';
import { logPrediction } from './log-prediction.js';
import { fetchApiFootball } from './utils/fetch-api.js';
import { getWeight } from './weights.js';

const PRE_MATCH_STATUSES = new Set(['NS']);
const LIVE_STATUSES = new Set(['1H','HT','2H','ET','BT','P','LIVE','INT']);
const FINISHED_STATUSES = new Set(['FT','AET','PEN','SUSP','ABD','AWD','WO']);
const SEASON = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;

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


function calcDynamicLambda(lambdaBase, elapsed, currentGoals, sot) {
  if (!elapsed || elapsed <= 0) return { lambda: lambdaBase, dynamic: false };
  const minutesLeft = Math.max(1, 90 - elapsed);
  const fraction = minutesLeft / 90;
  const shotRate = (sot / Math.max(elapsed, 1)) * 90;
  const intensityFactor = 1 + Math.min(shotRate / 25, 0.4);
  const lambdaRemaining = lambdaBase * fraction * intensityFactor;
  return { lambda: currentGoals + lambdaRemaining, dynamic: true };
}

function calcPoisson(hGames, aGames, h2h, hId, aId, elapsedParam, hgParam, agParam, sothParam, sotaParam, lgHome = 1.2, lgAway = 1.2, leagueStats = null) {
  const avg = (arr, fn) => arr.length ? arr.reduce((s, m) => s + fn(m), 0) / arr.length : 0;
  const pct = (arr, fn) => arr.length >= 5 ? Math.round(arr.filter(fn).length / arr.length * 100) : null;

  // Lambda Nivel 4 — temporal decay Dixon-Coles 1997 (phi = 0.0065, half-life ~107 zile)
  const phi = 0.0065;
  const now = Date.now();
  const weighted = (arr, valueFn) => {
    let sumW = 0, sumWV = 0;
    for (const m of arr) {
      const ageDays = m.match_date
        ? (now - new Date(m.match_date).getTime()) / 86_400_000
        : 30;
      const w = Math.exp(-phi * ageDays);
      sumW  += w;
      sumWV += w * valueFn(m);
    }
    return sumW > 0 ? sumWV / sumW : 0;
  };

  const homeAvgScored   = weighted(hGames, m => (m.teams?.home?.id === hId ? m.goals?.home : m.goals?.away) ?? 0);
  const homeAvgConceded = weighted(hGames, m => (m.teams?.home?.id === hId ? m.goals?.away : m.goals?.home) ?? 0);
  const awayAvgScored   = weighted(aGames, m => (m.teams?.away?.id === aId ? m.goals?.away : m.goals?.home) ?? 0);
  const awayAvgConceded = weighted(aGames, m => (m.teams?.away?.id === aId ? m.goals?.home : m.goals?.away) ?? 0);

  // Lambda Nivel 4 — Maher 1982: lambda = lgAvg × AttackStrength × DefenseStrength × HomeAdvantage
  // Normalizare față de media ligii elimină bias-ul cross-league (Premier League ≠ Liga 3 Finlanda)
  const lgHomeAvg = parseFloat(leagueStats?.avg_home_goals) || lgHome || 1.35;
  const lgAwayAvg = parseFloat(leagueStats?.avg_away_goals) || lgAway || 1.10;
  const homeAdvantage = 1.25;
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  const hAttStr = lgHomeAvg > 0 ? homeAvgScored   / lgHomeAvg : 1.0;
  const aDefStr = lgHomeAvg > 0 ? awayAvgConceded / lgHomeAvg : 1.0;
  const aAttStr = lgAwayAvg > 0 ? awayAvgScored   / lgAwayAvg : 1.0;
  const hDefStr = lgAwayAvg > 0 ? homeAvgConceded / lgAwayAvg : 1.0;

  let lambdaHome = hGames.length && aGames.length
    ? clamp(lgHomeAvg * clamp(hAttStr, 0.4, 2.5) * clamp(aDefStr, 0.4, 2.5) * homeAdvantage, 0.3, 4.5)
    : (lgHome ?? 1.35);
  let lambdaAway = hGames.length && aGames.length
    ? clamp(lgAwayAvg * clamp(aAttStr, 0.4, 2.5) * clamp(hDefStr, 0.4, 2.5), 0.3, 4.0)
    : (lgAway ?? 1.10);

  // Soluția 1 — H2H influențează λ direct (pre-meci, min. 3 meciuri directe)
  // Blend 70% formă + 30% H2H (scalat cu sample size, max 30%)
  if (h2h.length >= 3 && !parseInt(elapsedParam)) {
    const h2hAvgH = avg(h2h, m => m.teams?.home?.id === hId ? (m.goals?.home ?? 0) : (m.goals?.away ?? 0));
    const h2hAvgA = avg(h2h, m => m.teams?.away?.id === aId ? (m.goals?.away ?? 0) : (m.goals?.home ?? 0));
    const w = Math.min(0.30, h2h.length / 10 * 0.30);
    lambdaHome = +(lambdaHome * (1 - w) + h2hAvgH * w).toFixed(2);
    lambdaAway = +(lambdaAway * (1 - w) + h2hAvgA * w).toFixed(2);
  }

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
    over05Prob:      matrix.over05Prob,
    over15Prob:      matrix.over15Prob,
    over25Prob:      matrix.over25Prob,
    ggProb:          matrix.ggProb,
    homeWin:         matrix.homeWin,
    draw:            matrix.draw,
    awayWin:         matrix.awayWin,
    dc1x:            Math.min(100, matrix.homeWin + matrix.draw),
    dcx2:            Math.min(100, matrix.draw + matrix.awayWin),
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

async function getTopScorerFactor(teamId, leagueId) {
  if (!teamId || !leagueId) return 1.0;
  try {
    const { rows } = await query(
      `SELECT
         COALESCE((SELECT MAX(goals) FROM top_scorers WHERE team_id=$1 AND league_id=$2 AND season=$3), 0) AS team_top,
         COALESCE((SELECT AVG(goals)::numeric(5,2) FROM top_scorers WHERE league_id=$2 AND season=$3), 0) AS league_avg`,
      [teamId, Number(leagueId), SEASON]
    );
    const teamTop   = Number(rows[0]?.team_top)   || 0;
    const leagueAvg = Number(rows[0]?.league_avg) || 0;
    if (!teamTop || leagueAvg < 1) return 1.0;
    return Math.max(0.85, Math.min(1.15, teamTop / leagueAvg));
  } catch (_) { return 1.0; }
}

async function getSquadCount(teamId) {
  if (!teamId) return 0;
  try {
    const { rows } = await query(
      `SELECT COUNT(*) AS cnt FROM squads WHERE team_id=$1 AND season=$2`,
      [teamId, SEASON]
    );
    return parseInt(rows[0]?.cnt) || 0;
  } catch (_) { return 0; }
}

const LINEUP_TEAM_AVG = 55; // scor mediu echipă din players_season

async function getLineupStrengthFactor(fixtureId, homeId, awayId) {
  try {
    const { rows } = await query(
      `SELECT payload FROM prematch_data
       WHERE fixture_id=$1 AND data_type='lineups'
       ORDER BY stage DESC LIMIT 1`,
      [fixtureId]
    );
    if (!rows.length) return { home: 1.0, away: 1.0 };
    const lineups = rows[0].payload;
    if (!Array.isArray(lineups) || lineups.length < 2) return { home: 1.0, away: 1.0 };

    const findTeam = (id) => lineups.find(t => t.team?.id === id);
    const homeEntry = findTeam(homeId);
    const awayEntry = findTeam(awayId);
    if (!homeEntry || !awayEntry) return { home: 1.0, away: 1.0 };

    const extractIds = (entry) =>
      (entry.startXI || []).map(p => p.player?.id).filter(Boolean);
    const hIds = extractIds(homeEntry);
    const aIds = extractIds(awayEntry);
    if (hIds.length < 7 || aIds.length < 7) return { home: 1.0, away: 1.0 };

    const allIds = [...new Set([...hIds, ...aIds])];
    const { rows: ps } = await query(
      `SELECT player_id,
              (rating/10.0*100)*0.45
              + LEAST(100, COALESCE(goals,0)*25)*0.20
              + COALESCE(pass_accuracy,50)*0.20
              + LEAST(100, COALESCE(shots_on_target,0)*2)*0.15 AS score
       FROM players_season
       WHERE player_id = ANY($1) AND season=$2 AND appearances > 0`,
      [allIds, SEASON]
    );
    const scoreMap = Object.fromEntries(ps.map(r => [r.player_id, Number(r.score)]));

    const avgScore = (ids) => {
      const scored = ids.map(id => scoreMap[id]).filter(s => s != null);
      if (scored.length < 7) return null;
      return scored.reduce((s, v) => s + v, 0) / scored.length;
    };

    const hAvg = avgScore(hIds);
    const aAvg = avgScore(aIds);
    if (hAvg == null && aAvg == null) return { home: 1.0, away: 1.0 };

    const toFactor = (avg) =>
      avg != null ? Math.max(0.88, Math.min(1.12, avg / LINEUP_TEAM_AVG)) : 1.0;

    return { home: toFactor(hAvg), away: toFactor(aAvg) };
  } catch (_) { return { home: 1.0, away: 1.0 }; }
}

async function getTeamStrengths(hId, aId) {
  try {
    const [rH, rA] = await Promise.all([
      query('SELECT rating, goals, pass_accuracy, shots_on_target FROM player_stats WHERE team_id = $1 ORDER BY fixture_id DESC LIMIT 110', [hId]),
      query('SELECT rating, goals, pass_accuracy, shots_on_target FROM player_stats WHERE team_id = $1 ORDER BY fixture_id DESC LIMIT 110', [aId]),
    ]);

    const calcStr = (rows) => {
      if (!Array.isArray(rows) || rows.length < 10) return null;
      const rated        = rows.filter(r => r.rating);
      const avgRating    = rated.length ? rated.reduce((s, r) => s + Number(r.rating), 0) / rated.length : 5;
      const goalsPerGame = rows.reduce((s, r) => s + (r.goals || 0), 0) / rows.length;
      const withPass     = rows.filter(r => r.pass_accuracy != null);
      const avgPassAcc   = withPass.length ? withPass.reduce((s, r) => s + Number(r.pass_accuracy), 0) / withPass.length : 50;
      const avgSot       = rows.reduce((s, r) => s + (r.shots_on_target || 0), 0) / rows.length;
      const topScorer    = Math.max(...rows.map(r => r.goals || 0), 0);
      return Math.round(
        (avgRating / 10 * 100) * 0.35 +
        Math.min(100, goalsPerGame * 35) * 0.25 +
        avgPassAcc * 0.20 +
        Math.min(100, avgSot * 12) * 0.10 +
        Math.min(100, topScorer * 20) * 0.10
      );
    };

    // Fallback players_season cand player_stats insuficient (<10 randuri)
    const calcStrSeason = async (teamId) => {
      try {
        const { rows } = await query(
          `SELECT rating, goals, appearances FROM players_season
           WHERE team_id=$1 AND season=$2 AND appearances > 0`,
          [teamId, SEASON]
        );
        if (rows.length < 5) return null;
        const rated      = rows.filter(r => r.rating);
        const avgRating  = rated.length ? rated.reduce((s, r) => s + Number(r.rating), 0) / rated.length : 5;
        const totalGoals = rows.reduce((s, r) => s + (r.goals || 0), 0);
        const totalApps  = rows.reduce((s, r) => s + (r.appearances || 0), 0);
        const topScorer  = Math.max(...rows.map(r => r.goals || 0), 0);
        return Math.round(
          (avgRating / 10 * 100) * 0.45 +
          Math.min(100, totalApps > 0 ? (totalGoals / totalApps) * 50 : 0) * 0.35 +
          Math.min(100, topScorer * 5) * 0.20
        );
      } catch (_) { return null; }
    };

    const strH = calcStr(rH.rows);
    const strA = calcStr(rA.rows);
    const finalH = strH ?? await calcStrSeason(hId);
    const finalA = strA ?? await calcStrSeason(aId);

    return {
      home:       finalH,
      away:       finalA,
      homeSource: strH != null ? 'ps' : finalH != null ? 'pss' : null,
      awaySource: strA != null ? 'ps' : finalA != null ? 'pss' : null,
    };
  } catch (_) {
    return { home: null, away: null };
  }
}

async function getInjuredPlayerScores(injuries, homeId, awayId) {
  if (!injuries || !injuries.length) return { home: [], away: [] };
  const playerIds = injuries.map(i => i.player_id).filter(Boolean);
  if (!playerIds.length) return { home: [], away: [] };
  try {
    const { rows } = await query(
      `SELECT player_id, team_id, goals, assists, rating, minutes
       FROM players_season WHERE player_id = ANY($1) AND season = $2`,
      [playerIds, SEASON]
    );
    const calcScore = (r) => {
      const rn  = r.rating ? +(Number(r.rating) / 10 * 100) : 50;
      const gs  = Math.min(100, (r.goals   || 0) * 25);
      const as_ = Math.min(100, (r.assists  || 0) * 20);
      const ms  = Math.min(100, (r.minutes  || 0) / 2500 * 100);
      return Math.round(rn * 0.40 + gs * 0.30 + as_ * 0.20 + ms * 0.10);
    };
    const scoreMap = {};
    for (const r of rows) scoreMap[r.player_id] = { score: calcScore(r), teamId: Number(r.team_id) };
    const home = [], away = [];
    for (const inj of injuries) {
      if (!inj.player_id) continue;
      const data = scoreMap[inj.player_id];
      if (!data) continue;
      const tid = Number(inj.team_id) || data.teamId;
      const entry = { id: inj.player_id, name: inj.player_name, score: data.score };
      if (tid === homeId) home.push(entry);
      else if (tid === awayId) away.push(entry);
    }
    return { home, away };
  } catch (_) { return { home: [], away: [] }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIDENCE SCORING — 2 funcții distincte (pre-meci / live) + wrapper compat
// ─────────────────────────────────────────────────────────────────────────────
// Upgrade 29.05.2026 (Sprint Confidence Refactor):
//   - score2: include apărarea (atac 60% + apărare 40%) — nu doar atac
//   - score3: null explicit când H2H sample <3 (forțează redistribuire dinamică);
//             combo h2hOver15 60% + h2hGG 40% când sample suficient
//   - score6: convergență reală (100 - stdDev), nu prag binar arbitrar
//   - score7: match-up atac vs apărare (multiplier 1.5), nu medie simplă H+A
//
// Helper comun — calculează score1, score2, score3, score6, score7 (fără score4)
function _calcConfidenceCommonScores(result, teamStrengths) {
  // ── score1 — Poisson ─────────────────────────────────────────────
  const score1 = result.over15Prob ?? 50;

  // ── score2 — Formă (atac + apărare) ──────────────────────────────
  const homeAtk = result.homeAvgScored   ?? 1.2;
  const awayAtk = result.awayAvgScored   ?? 1.0;
  const homeDef = result.homeAvgConceded ?? 1.2;
  const awayDef = result.awayAvgConceded ?? 1.0;
  const attackQuality   = Math.min(100, (homeAtk + awayAtk) / 3.5 * 100);
  const defenseLeakiness = Math.min(100, (homeDef + awayDef) / 3.5 * 100);
  const score2 = Math.round(attackQuality * 0.6 + defenseLeakiness * 0.4);

  // ── score3 — H2H (null când sample <3) ───────────────────────────
  let score3 = null;
  if (result.h2hOver15 != null && result.h2hSample >= 3) {
    const ggComponent = result.h2hGG ?? result.h2hOver15;
    score3 = Math.round(result.h2hOver15 * 0.6 + ggComponent * 0.4);
  }

  // ── score7 — Putere Echipe (match-up atac vs apărare) ────────────
  let score7 = null;
  let teamStrengthHome = null, teamStrengthAway = null;
  if (teamStrengths && (teamStrengths.home != null || teamStrengths.away != null)) {
    teamStrengthHome = teamStrengths.home;
    teamStrengthAway = teamStrengths.away;
    const homeStr = teamStrengths.home ?? 50;
    const awayStr = teamStrengths.away ?? 50;
    const homeAttackVsAwayDef = homeStr * (100 - awayStr) / 100;
    const awayAttackVsHomeDef = awayStr * (100 - homeStr) / 100;
    score7 = Math.round((homeAttackVsAwayDef + awayAttackVsHomeDef) / 2 * 1.5);
    score7 = Math.max(0, Math.min(100, score7));
  }

  return { score1, score2, score3, score7, teamStrengthHome, teamStrengthAway };
}

// Helper comun — score6 (convergență stdDev) din scoruri active
function _calcConvergence(allScores) {
  const active = allScores.filter(s => s !== null);
  if (active.length < 2) return null;
  const mean = active.reduce((s, v) => s + v, 0) / active.length;
  const variance = active.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / active.length;
  const stdDev = Math.sqrt(variance);
  return Math.round(Math.max(0, Math.min(100, 100 - stdDev)));
}

// Helper comun — penalizări runtime + clamp final + return shape
function _finalizeConfidence(layers, score1, score2, score3, score6, score7,
                             teamStrengthHome, teamStrengthAway, liveStats) {
  const filtered = layers.filter(l => l.score !== null).filter(l => l.w > 0);
  const totalW = filtered.reduce((s, l) => s + l.w, 0);
  const confidenceScore = totalW > 0
    ? Math.round(filtered.reduce((s, l) => s + l.score * (l.w / totalW), 0))
    : 50;
  const hasStr = score7 != null;

  // Penalizări runtime — aplicate pe scorul final, NU pe straturi individuale
  let adjustedScore = confidenceScore;
  const elapsed  = liveStats?.elapsed ?? 0;
  const sotTotal = liveStats?.sot     ?? null;
  const ycTotal  = liveStats?.yc      ?? 0;

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
      h2h:          score3 != null ? Math.round(score3) : null,
      live:         score3 != null /* placeholder — supraînscris de caller */ ? null : null,
      consistenta:  score6 != null ? Math.round(score6) : null,
      ...(hasStr ? { putereEchipe: score7 } : {}),
    },
    teamStrengthHome,
    teamStrengthAway,
  };
}

// FUNCȚIA 1: calcConfidencePreMatch — pre-meci (fără liveStats)
function calcConfidencePreMatch(result, teamStrengths) {
  const { score1, score2, score3, score7, teamStrengthHome, teamStrengthAway } =
    _calcConfidenceCommonScores(result, teamStrengths);

  // Convergența ia în calcul DOAR straturile pre-meci active
  const score6 = _calcConvergence([score1, score2, score3, score7]);

  // Greutăți pre-meci (suma = 1.00)
  const layers = [
    { score: score1, w: 0.30 }, // Poisson
    { score: score2, w: 0.25 }, // Formă+Apărare
    { score: score3, w: 0.15 }, // H2H combo
    { score: score7, w: 0.25 }, // Putere Echipe
    { score: score6, w: 0.05 }, // Convergență
  ];

  const out = _finalizeConfidence(
    layers, score1, score2, score3, score6, score7,
    teamStrengthHome, teamStrengthAway, null
  );
  // breakdown.live = null explicit pentru pre-meci
  out.breakdown.live = null;
  return out;
}

// FUNCȚIA 2: calcConfidenceLive — meci în desfășurare (cu liveStats)
function calcConfidenceLive(result, liveStats, teamStrengths) {
  const { score1, score2, score3, score7, teamStrengthHome, teamStrengthAway } =
    _calcConfidenceCommonScores(result, teamStrengths);

  // ── score4 — Live xG/SOT/DA ──────────────────────────────────────
  const sot = liveStats.sot || 0;
  const xg  = liveStats.xg  || 0;
  const da  = liveStats.da  || 0;
  const elapsed = liveStats.elapsed || 0;
  let score4live;
  if (sot === 0 && elapsed > 10) {
    score4live = 20;
  } else {
    score4live = Math.min(100, xg * 25 + sot * 3 + da * 0.5);
  }

  // Convergența include score4 live (înlocuiește score3 dacă null — redundanță evitată)
  const score6 = _calcConvergence([score1, score2, score3, score4live, score7]);

  // Greutăți live (suma = 1.00)
  const layers = [
    { score: score4live, w: 0.35 }, // Live xG
    { score: score1,     w: 0.20 }, // Poisson
    { score: score2,     w: 0.20 }, // Formă+Apărare
    { score: score7,     w: 0.15 }, // Putere Echipe
    { score: score6,     w: 0.10 }, // Convergență
  ];

  const out = _finalizeConfidence(
    layers, score1, score2, score3, score6, score7,
    teamStrengthHome, teamStrengthAway, liveStats
  );
  out.breakdown.live = Math.round(score4live);
  return out;
}

// WRAPPER — păstrează semnătura externă (zero breaking changes pentru apelanți)
function calcConfidence(result, liveStats, teamStrengths) {
  if (liveStats && liveStats.elapsed > 0) {
    return calcConfidenceLive(result, liveStats, teamStrengths);
  }
  return calcConfidencePreMatch(result, teamStrengths);
}

// --- PostgreSQL data helpers ---

async function getHomeForm(teamId) {
  try {
    const r = await query(
      `SELECT home_team_id, away_team_id, home_goals, away_goals, match_date
       FROM fixtures_history
       WHERE home_team_id = $1
         AND status_short = 'FT'
         AND home_goals IS NOT NULL
         AND match_date >= NOW() - INTERVAL '2 years'
       ORDER BY match_date DESC
       LIMIT 10`,
      [teamId]
    );
    return r.rows.map(row => ({
      teams: { home: { id: row.home_team_id }, away: { id: row.away_team_id } },
      goals: { home: row.home_goals ?? 0, away: row.away_goals ?? 0 },
      match_date: row.match_date,
    }));
  } catch (_) { return []; }
}

async function getAwayForm(teamId) {
  try {
    const r = await query(
      `SELECT home_team_id, away_team_id, home_goals, away_goals, match_date
       FROM fixtures_history
       WHERE away_team_id = $1
         AND status_short = 'FT'
         AND home_goals IS NOT NULL
         AND match_date >= NOW() - INTERVAL '2 years'
       ORDER BY match_date DESC
       LIMIT 10`,
      [teamId]
    );
    return r.rows.map(row => ({
      teams: { home: { id: row.home_team_id }, away: { id: row.away_team_id } },
      goals: { home: row.home_goals ?? 0, away: row.away_goals ?? 0 },
      match_date: row.match_date,
    }));
  } catch (_) { return []; }
}

async function getH2HFromDB(homeId, awayId) {
  // Sursa primară: tabelul h2h (populat de scanner.js din meciuri FT live)
  let h2hRows = [];
  try {
    const r = await query(
      `SELECT * FROM h2h WHERE ((home_team_id = $1 AND away_team_id = $2) OR (home_team_id = $2 AND away_team_id = $1)) AND match_date >= NOW() - INTERVAL '2 years' ORDER BY match_date DESC LIMIT 10`,
      [homeId, awayId]
    );
    h2hRows = r.rows;
  } catch (_) { h2hRows = []; }

  // Fallback: dacă h2h <3 meciuri, completează din fixtures_history.
  // Motivul: scanner.js populează h2h DOAR din meciurile observate live.
  // Echipele care nu au jucat live recent au h2h gol, deși fixtures_history are datele.
  if (h2hRows.length < 3) {
    try {
      const fh = await query(
        `SELECT home_team_id, away_team_id, home_goals, away_goals, match_date, fixture_id
         FROM fixtures_history
         WHERE ((home_team_id = $1 AND away_team_id = $2)
             OR (home_team_id = $2 AND away_team_id = $1))
           AND status_short = 'FT'
           AND home_goals IS NOT NULL
         ORDER BY match_date DESC
         LIMIT 10`,
        [homeId, awayId]
      );
      // Dedupe după fixture_id (cheie unică), păstrând prioritate h2h table (sursa primară)
      const seenFids = new Set(h2hRows.map(r => r.fixture_id).filter(v => v != null));
      for (const row of fh.rows) {
        if (row.fixture_id != null && seenFids.has(row.fixture_id)) continue;
        h2hRows.push(row);
      }
      // Re-sortare DESC după match_date + cap la 10
      h2hRows.sort((a, b) => new Date(b.match_date) - new Date(a.match_date));
      h2hRows = h2hRows.slice(0, 10);
    } catch (_) { /* păstrează h2hRows existent */ }
  }

  return h2hRows;
}

async function getInjuriesFromDB(fixtureId) {
  try {
    const r = await query('SELECT * FROM injuries WHERE fixture_id = $1', [fixtureId]);
    if (r.rows.length > 0) return r.rows;

    // Fallback: prematch_data stochează injuries ca array JSON brut
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

async function getStandingsForTeam(teamId, leagueId) {
  if (!teamId || !leagueId) return null;
  try {
    const { rows } = await query(
      `SELECT goals_for, goals_against, played FROM standings
       WHERE team_id = $1 AND league_id = $2
       ORDER BY season DESC LIMIT 1`,
      [Number(teamId), Number(leagueId)]
    );
    const s = rows[0];
    if (!s || s.played < 5) return null;
    return {
      avgScored:   +(s.goals_for    / s.played).toFixed(2),
      avgConceded: +(s.goals_against / s.played).toFixed(2),
    };
  } catch (_) { return null; }
}

async function getPrematchPredictions(fixtureId) {
  if (!fixtureId) return null;
  try {
    const { rows } = await query(
      `SELECT payload FROM prematch_data WHERE fixture_id = $1 AND data_type = 'predictions'
       ORDER BY collected_at DESC LIMIT 1`,
      [fixtureId]
    );
    if (!rows.length) return null;
    const arr = rows[0].payload;
    return Array.isArray(arr) && arr[0] ? arr[0] : null;
  } catch (_) { return null; }
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  const { h, a, fid, hn, an, lg, lgid, dt, elapsed, hg, ag, soth, sota, ref, status_short } = req.query;
  if (!h || !a) return res.status(400).json({ error: 'Parametri h si a sunt necesari' });

  const hId = Number(h);
  const aId = Number(a);

  try {
    // --- Batch 1: DB queries + team strengths + injuries + match_stats + venue in parallel ---
    const [sbHForm, sbAForm, sbH2H, teamStrengths, injuries, matchStats, leagueStats, refereeStats, venueInfo, stnH, stnA, apiPred, topScorerFactorH, topScorerFactorA, squadCntH, squadCntA, lineupFactor] = await Promise.all([
      getHomeForm(hId),
      getAwayForm(aId),
      getH2HFromDB(hId, aId),
      getTeamStrengths(hId, aId),
      fid ? getInjuriesFromDB(Number(fid)) : Promise.resolve([]),
      fid ? getMatchStatsFromDB(Number(fid)) : Promise.resolve([]),
      getLeagueStats(lgid),
      getRefereeStats(ref || null),
      fid ? getVenueForFixture(Number(fid)) : Promise.resolve(null),
      lgid ? getStandingsForTeam(hId, lgid) : Promise.resolve(null),
      lgid ? getStandingsForTeam(aId, lgid) : Promise.resolve(null),
      fid  ? getPrematchPredictions(Number(fid)) : Promise.resolve(null),
      lgid ? getTopScorerFactor(hId, lgid)   : Promise.resolve(1.0),
      lgid ? getTopScorerFactor(aId, lgid)   : Promise.resolve(1.0),
      getSquadCount(hId),
      getSquadCount(aId),
      fid ? getLineupStrengthFactor(Number(fid), hId, aId) : Promise.resolve({ home: 1.0, away: 1.0 }),
    ]);

    // --- Batch 2: API-Football fallbacks only where DB had insufficient data ---
    const needHForm = sbHForm.length  < 3;
    const needAForm = sbAForm.length  < 3;
    const needH2H   = sbH2H.length    < 3;

    const [apiFbHForm, apiFbAForm, apiFbH2H, injuredScores] = await Promise.all([
      needHForm ? fetchApiFootball(`/fixtures?team=${h}&last=20&status=FT`).then(r => r.json()) : null,
      needAForm ? fetchApiFootball(`/fixtures?team=${a}&last=20&status=FT`).then(r => r.json()) : null,
      needH2H   ? fetchApiFootball(`/fixtures/headtohead?h2h=${h}-${a}&last=10`).then(r => r.json()) : null,
      getInjuredPlayerScores(injuries, hId, aId),
    ]);

    // Resolve final datasets — meciuri mai vechi de 2 ani excluse din toate calculele
    const _cutoff = new Date(Date.now() - 2 * 365.25 * 24 * 3600 * 1000);
    const _fresh = arr => (arr || []).filter(m => {
      const d = m?.fixture?.date || m?.date;
      return d ? new Date(d) >= _cutoff : true;
    });
    const hGames = needHForm ? _fresh(apiFbHForm?.response).slice(0, 10) : sbHForm;
    const aGames = needAForm ? _fresh(apiFbAForm?.response).slice(0, 10) : sbAForm;
    const h2h = needH2H
      ? _fresh(apiFbH2H?.response).slice(0, 10)
      : h2hToFixtures(sbH2H);

    // teams_stats fallback when form still insufficient after API
    const formInsufficient = hGames.length < 3 || aGames.length < 3;
    const [tsH, tsA] = formInsufficient
      ? await Promise.all([
          getTeamStatsFromDB(hId, lgid),
          getTeamStatsFromDB(aId, lgid),
        ])
      : [null, null];

    // --- Calculations ---
    const lgHome = parseFloat(leagueStats?.avg_home_goals) || 1.2;
    const lgAway = parseFloat(leagueStats?.avg_away_goals) || 1.2;
    const result = calcPoisson(hGames, aGames, h2h, hId, aId, elapsed, hg, ag, soth, sota, lgHome, lgAway, leagueStats);
    // Fix h2hSample: când fallback API se activează dar și DB combinat are date,
    // h2hSample trebuie să reflecte ARRAYUL FINAL real folosit în calcPoisson.
    // calcPoisson primește h2h care e: needH2H ? API : h2hToFixtures(sbH2H combinat).
    // sbH2H este deja combinat (h2h table + fixtures_history fallback) prin getH2HFromDB.
    // Suprascriem cu lungimea reală a sample-ului DB combinat când acesta există,
    // pentru a evita raportarea h2hSample=0 când datele DB au fost incluse.
    result.h2hSample = Math.max(result.h2hSample || 0, sbH2H.length, h2h.length);
    const lambdaHomeRaw = result.lambdaHome;
    const lambdaAwayRaw = result.lambdaAway;

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

    // Standings lambda blend — 60% form recent + 40% medie sezonala (Hybrid V2)
    if (!formInsufficient && stnH && stnA) {
      const stnLambdaH = (stnH.avgScored + stnA.avgConceded) / 2;
      const stnLambdaA = (stnA.avgScored + stnH.avgConceded) / 2;
      result.lambdaHome  = +(result.lambdaHome * 0.6 + stnLambdaH * 0.4).toFixed(2);
      result.lambdaAway  = +(result.lambdaAway * 0.6 + stnLambdaA * 0.4).toFixed(2);
      result.lambdaTotal = +(result.lambdaHome + result.lambdaAway).toFixed(2);
      const mxStn = calcPoisson6x6(result.lambdaHome, result.lambdaAway);
      Object.assign(result, {
        over15Prob: mxStn.over15Prob, over25Prob: mxStn.over25Prob,
        ggProb: mxStn.ggProb, homeWin: mxStn.homeWin,
        draw: mxStn.draw, awayWin: mxStn.awayWin,
      });
      result._standingsBlend = `H(${stnH.avgScored}/${stnH.avgConceded})|A(${stnA.avgScored}/${stnA.avgConceded})`;
    }

    // Top scorer factor — lambda ajustat cu puterea atacantului de top vs media ligii (±15% max)
    if (lgid && (topScorerFactorH !== 1.0 || topScorerFactorA !== 1.0)) {
      result.lambdaHome  = +(result.lambdaHome  * topScorerFactorH).toFixed(2);
      result.lambdaAway  = +(result.lambdaAway  * topScorerFactorA).toFixed(2);
      result.lambdaTotal = +(result.lambdaHome + result.lambdaAway).toFixed(2);
      const mxTsf = calcPoisson6x6(result.lambdaHome, result.lambdaAway);
      Object.assign(result, {
        over15Prob: mxTsf.over15Prob, over25Prob: mxTsf.over25Prob,
        ggProb: mxTsf.ggProb, homeWin: mxTsf.homeWin,
        draw: mxTsf.draw, awayWin: mxTsf.awayWin,
      });
      result._topScorerFactor = `H:${topScorerFactorH.toFixed(2)}|A:${topScorerFactorA.toFixed(2)}`;
    }

    // L2 — Confirmed lineup strength factor (±12% max, requires ≥7/11 starters with data)
    if (fid && (lineupFactor.home !== 1.0 || lineupFactor.away !== 1.0)) {
      result.lambdaHome  = +(result.lambdaHome  * lineupFactor.home).toFixed(2);
      result.lambdaAway  = +(result.lambdaAway  * lineupFactor.away).toFixed(2);
      result.lambdaTotal = +(result.lambdaHome + result.lambdaAway).toFixed(2);
      const mxLU = calcPoisson6x6(result.lambdaHome, result.lambdaAway);
      Object.assign(result, {
        over15Prob: mxLU.over15Prob, over25Prob: mxLU.over25Prob,
        ggProb: mxLU.ggProb, homeWin: mxLU.homeWin,
        draw: mxLU.draw, awayWin: mxLU.awayWin,
      });
      result._lineupFactor = `H:${lineupFactor.home.toFixed(2)}|A:${lineupFactor.away.toFixed(2)}`;
    }

    // Smart injury lambda penalty — jucători importanți lipsă reduc puterea de atac
    if (fid && Array.isArray(injuries) && injuries.length > 0) {
      const applyInjLambda = (players) => {
        if (!players.length) return 1.0;
        const top = Math.max(...players.map(p => p.score));
        if (top > 80) return 0.88;
        if (top > 65) return 0.94;
        if (top > 45) return 0.97;
        return 1.0;
      };
      const injFactorH = applyInjLambda(injuredScores.home);
      const injFactorA = applyInjLambda(injuredScores.away);
      if (injFactorH !== 1.0 || injFactorA !== 1.0) {
        result.lambdaHome  = +(result.lambdaHome  * injFactorH).toFixed(2);
        result.lambdaAway  = +(result.lambdaAway  * injFactorA).toFixed(2);
        result.lambdaTotal = +(result.lambdaHome + result.lambdaAway).toFixed(2);
        const mxInj = calcPoisson6x6(result.lambdaHome, result.lambdaAway);
        Object.assign(result, {
          over15Prob: mxInj.over15Prob, over25Prob: mxInj.over25Prob,
          ggProb: mxInj.ggProb, homeWin: mxInj.homeWin,
          draw: mxInj.draw, awayWin: mxInj.awayWin,
        });
        result._injuryLambda = `H:${injFactorH.toFixed(2)}|A:${injFactorA.toFixed(2)}`;
      }
    }

    // Model-weights lambda multiplier — auto-calibrare per ligă din learning-analysis
    if (lgid) {
      const lgKey = `league_${lgid}`;
      const mult = getWeight('OVER15', lgKey, 'lambda_multiplier') ?? 1.0;
      if (mult !== 1.0) {
        result.lambdaHome  = +(result.lambdaHome  * mult).toFixed(2);
        result.lambdaAway  = +(result.lambdaAway  * mult).toFixed(2);
        result.lambdaTotal = +(result.lambdaHome + result.lambdaAway).toFixed(2);
        const mxW = calcPoisson6x6(result.lambdaHome, result.lambdaAway);
        Object.assign(result, {
          over15Prob: mxW.over15Prob, over25Prob: mxW.over25Prob,
          ggProb: mxW.ggProb, homeWin: mxW.homeWin,
          draw: mxW.draw, awayWin: mxW.awayWin,
        });
        result._lambdaMultiplier = mult.toFixed(3);
      }
    }

    // Soluția 2 — plafon ajustări: nicio combinație de straturi nu reduce λ cu mai mult de 20%
    if (!parseInt(elapsed)) {
      const floorH = +(lambdaHomeRaw * 0.80).toFixed(2);
      const floorA = +(lambdaAwayRaw * 0.80).toFixed(2);
      if (result.lambdaHome < floorH || result.lambdaAway < floorA) {
        result.lambdaHome  = +Math.max(result.lambdaHome, floorH).toFixed(2);
        result.lambdaAway  = +Math.max(result.lambdaAway, floorA).toFixed(2);
        result.lambdaTotal = +(result.lambdaHome + result.lambdaAway).toFixed(2);
        const mxFloor = calcPoisson6x6(result.lambdaHome, result.lambdaAway);
        Object.assign(result, {
          over15Prob: mxFloor.over15Prob, over25Prob: mxFloor.over25Prob,
          ggProb: mxFloor.ggProb, homeWin: mxFloor.homeWin,
          draw: mxFloor.draw, awayWin: mxFloor.awayWin,
        });
      }
    }

    // Sync homeScoreRate/awayScoreRate cu lambda-urile finale calibrate
    result.homeScoreRate = Math.round((1 - Math.exp(-result.lambdaHome)) * 100);
    result.awayScoreRate = Math.round((1 - Math.exp(-result.lambdaAway)) * 100);

    // Soluția 3 — GG corectat din H2H (blend 60% Poisson + 40% H2H, min. 3 meciuri directe)
    if (result.h2hGG != null && result.h2hSample >= 3 && !parseInt(elapsed)) {
      result.ggProb = Math.round(result.ggProb * 0.60 + result.h2hGG * 0.40);
    }

    // Venue + altitude impact (Faza 1 Hybrid)
    if (venueInfo) {
      const altM    = Number(venueInfo.altitude_m) || 0;
      const surface = venueInfo.surface || null;
      const impSrc  = [];
      if (altM > 2500) {
        result.over15Prob = Math.max(0, Math.min(100, result.over15Prob * 0.78));
        result.over25Prob = Math.max(0, Math.min(100, result.over25Prob * 0.70));
        impSrc.push(`altitude_extreme(${altM}m)`);
      } else if (altM > 2000) {
        result.over15Prob = Math.max(0, Math.min(100, result.over15Prob * 0.88));
        result.over25Prob = Math.max(0, Math.min(100, result.over25Prob * 0.82));
        impSrc.push(`altitude_high(${altM}m)`);
      } else if (altM > 1500) {
        result.over15Prob = Math.max(0, Math.min(100, result.over15Prob * 0.94));
        result.over25Prob = Math.max(0, Math.min(100, result.over25Prob * 0.90));
        impSrc.push(`altitude_mid(${altM}m)`);
      }
      if (surface === 'artificial') {
        result.over25Prob = Math.max(0, Math.min(100, result.over25Prob * 1.05));
        impSrc.push('artificial_turf');
      }
      if (impSrc.length) result._venueMeteoImpact = impSrc.join(',');
      result._venueSurface  = surface;
      result._venueAltitude = altM || null;
    }

    // Coach impact (Faza 2 Hybrid) — aplicat pentru ambele echipe agregat
    try {
      const homeImp = await getCoachImpact(hId);
      const awayImp = await getCoachImpact(aId);
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

    // Referee impact (Faza 3 Hybrid) — home bias + cards prediction
    try {
      if (ref) {
        const refImp = await getRefereeImpact(ref);
        if (refImp.source.length > 0) {
          result.homeWin = Math.max(0, Math.min(100, result.homeWin * refImp.homeWin));
          result.over25Prob = Math.max(0, Math.min(100, result.over25Prob * refImp.over25));
          if (refImp.over35Cards != null) result.refOver35Cards = refImp.over35Cards;
          result._refereeImpact = refImp.source.join(',');
        }
      }
    } catch (_) { /* silent */ }

    // Ajustare Over 2.5 bazată pe stilul arbitrului
    if (refereeStats && Number(refereeStats.total_matches) >= 5) {
      if (refereeStats.referee_style === 'open')
        result.over25Prob = Math.min(100, result.over25Prob + 5);
      else if (refereeStats.referee_style === 'closed')
        result.over25Prob = Math.max(0, result.over25Prob - 5);
    }

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

    const confData = calcConfidence(result, liveStats, teamStrengths);

    if (elapsed && parseInt(elapsed) > 0) {
      confData.breakdown.xg_source = xgSource;
    }

    // --- Injuries adjustment — smart penalty bazat pe scorul individual al jucătorului ---
    if (fid && Array.isArray(injuries) && injuries.length > 0) {
      const topH = injuredScores.home.length ? Math.max(...injuredScores.home.map(p => p.score)) : 0;
      const topA = injuredScores.away.length ? Math.max(...injuredScores.away.map(p => p.score)) : 0;
      const topScore = Math.max(topH, topA);
      let injuryPenalty = 0;
      if (topScore > 85)       injuryPenalty = 15;
      else if (topScore > 70)  injuryPenalty = 10;
      else if (topScore > 50)  injuryPenalty = 5;
      else if (injuries.length >= 3) injuryPenalty = 3;
      if (injuryPenalty > 0) {
        confData.confidenceScore = Math.max(10, confData.confidenceScore - injuryPenalty);
        const starNames = [...injuredScores.home, ...injuredScores.away]
          .filter(p => p.score > 50).map(p => p.name).filter(Boolean).join(', ');
        confData.breakdown.injuries = {
          layer: 'injuries',
          value: -injuryPenalty,
          note:  starNames ? `Stars: ${starNames}` : `${injuries.length} accidentați`,
        };
      }
    }

    // Squad completeness — penalizare lot incomplet (date din squads table)
    if (squadCntH > 0 || squadCntA > 0) {
      let squadPenalty = 0;
      const sqNotes = [];
      if (squadCntH > 0 && squadCntH < 11) { squadPenalty += 10; sqNotes.push(`H<11(${squadCntH})`); }
      else if (squadCntH > 0 && squadCntH < 14) { squadPenalty += 5; sqNotes.push(`H<14(${squadCntH})`); }
      if (squadCntA > 0 && squadCntA < 11) { squadPenalty += 10; sqNotes.push(`A<11(${squadCntA})`); }
      else if (squadCntA > 0 && squadCntA < 14) { squadPenalty += 5; sqNotes.push(`A<14(${squadCntA})`); }
      if (squadPenalty > 0) {
        confData.confidenceScore = Math.max(10, confData.confidenceScore - squadPenalty);
        confData.breakdown.squads = { home: squadCntH, away: squadCntA, penalty: -squadPenalty };
      }
    }

    // Calculez probabilități cartonașe/cornere pentru piețele biletului compus
    const _lgAvgYellow  = leagueStats ? +(leagueStats.avg_yellow_cards) || 3.5 : 3.5;
    const _lgAvgCorners = leagueStats ? +(leagueStats.avg_corners)       || 9.0 : 9.0;
    const _refAvgYellow  = (refereeStats && Number(refereeStats.total_matches) >= 5)
      ? +(refereeStats.avg_yellow_cards) || _lgAvgYellow : _lgAvgYellow;
    const _refAvgCorners = (refereeStats && Number(refereeStats.total_matches) >= 5)
      ? +(refereeStats.avg_corners)      || _lgAvgCorners : _lgAvgCorners;
    const { poissonProbOver: _ppo } = await import('./calc-utils.js');
    const cardsOver35  = _ppo(_refAvgYellow,  3);
    const cardsOver45  = _ppo(_refAvgYellow,  4);
    const cornersOver85 = _ppo(_refAvgCorners, 8);
    const cornersOver95 = _ppo(_refAvgCorners, 9);

    const payload = { ...result, ...confData,
      cardsOver35, cardsOver45, cornersOver85, cornersOver95,
      leagueStats: leagueStats || null, refereeStats: refereeStats || null };

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
            null,
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
            venue_surface: venueInfo?.surface || null,
            referee_name:  ref || null,
            module: 'OVER15',
            predicted_value: payload.over15Prob, threshold_used: 65,
            lambda_home: payload.lambdaHome, lambda_away: payload.lambdaAway,
            injuries_home: Array.isArray(injuries) ? injuries.filter(i => i.team_id === hId).length : 0,
            injuries_away: Array.isArray(injuries) ? injuries.filter(i => i.team_id === aId).length : 0,
            layer1: payload.breakdown?.poisson     ?? null,
            layer2: payload.breakdown?.forma        ?? null,
            layer3: payload.breakdown?.h2h          ?? null,
            layer4: payload.breakdown?.live         ?? null,
            layer5: null,
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
              venue_surface: venueInfo?.surface || null,
              referee_name:  ref || null,
              module: 'CONFIDENCE',
              predicted_value: payload.confidenceScore, threshold_used: 70,
              lambda_home: payload.lambdaHome, lambda_away: payload.lambdaAway,
              injuries_home: Array.isArray(injuries) ? injuries.filter(i => i.team_id === hId).length : 0,
              injuries_away: Array.isArray(injuries) ? injuries.filter(i => i.team_id === aId).length : 0,
              layer1: payload.breakdown?.poisson     ?? null,
              layer2: payload.breakdown?.forma        ?? null,
              layer3: payload.breakdown?.h2h          ?? null,
              layer4: payload.breakdown?.live         ?? null,
              layer5: null,
              layer6: payload.breakdown?.consistenta  ?? null,
              layer7: payload.breakdown?.putereEchipe ?? null,
            }).catch(() => {});
          }
        }

        // Salveaza/actualizeaza predicția pre-meci — mereu ultima versiune (DO UPDATE)
        // WHERE result_over15 IS NULL garanteaza ca nu suprascrie dupa ce meciul s-a jucat
        const apiHomePct = apiPred ? (parseFloat(apiPred.predictions?.percent?.home) || null) : null;
        const apiDrawPct = apiPred ? (parseFloat(apiPred.predictions?.percent?.draw) || null) : null;
        const apiAwayPct = apiPred ? (parseFloat(apiPred.predictions?.percent?.away) || null) : null;
        query(
          `INSERT INTO predictions (fixture_id, home_team, away_team, league_name, league_id, match_date,
            lambda_home, lambda_away, lambda_total, over15_prob, over25_prob, gg_prob,
            home_score_rate, away_score_rate, h2h_over15, confidence,
            api_home_pct, api_draw_pct, api_away_pct)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
          ON CONFLICT (fixture_id) DO UPDATE SET
            lambda_home=EXCLUDED.lambda_home, lambda_away=EXCLUDED.lambda_away,
            lambda_total=EXCLUDED.lambda_total,
            over15_prob=EXCLUDED.over15_prob, over25_prob=EXCLUDED.over25_prob,
            gg_prob=EXCLUDED.gg_prob, home_score_rate=EXCLUDED.home_score_rate,
            away_score_rate=EXCLUDED.away_score_rate, h2h_over15=EXCLUDED.h2h_over15,
            confidence=EXCLUDED.confidence,
            api_home_pct=COALESCE(EXCLUDED.api_home_pct, predictions.api_home_pct),
            api_draw_pct=COALESCE(EXCLUDED.api_draw_pct, predictions.api_draw_pct),
            api_away_pct=COALESCE(EXCLUDED.api_away_pct, predictions.api_away_pct),
            updated_at=NOW()
          WHERE predictions.result_over15 IS NULL`,
          [
            Number(fid), hn || '', an || '', lg || '', lgid ? Number(lgid) : null, dt || null,
            payload.lambdaHome, payload.lambdaAway, payload.lambdaTotal,
            payload.over15Prob, payload.over25Prob, payload.ggProb,
            payload.homeScoreRate, payload.awayScoreRate, payload.h2hOver15,
            payload.confidenceScore || null,
            apiHomePct, apiDrawPct, apiAwayPct,
          ]
        ).catch(() => {});
      }

    }

    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
