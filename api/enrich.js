import { calcPoisson6x6 } from './calc-utils.js';
import { predictAllMarkets, predictLiveMarketsV2 } from './ml-predict.js';
import { query } from './db.js';
import { logPrediction } from './log-prediction.js';
import { fetchApiFootball } from './utils/fetch-api.js';
import { getWeight } from './weights.js';

const PRE_MATCH_STATUSES = new Set(['NS']);
const LIVE_STATUSES = new Set(['1H','HT','2H','ET','BT','P','LIVE','INT']);
const FINISHED_STATUSES = new Set(['FT','AET','PEN','SUSP','ABD','AWD','WO']);
const SEASON = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;

// [C3] Cache in-memory pentru /api/enrich — taie recalculul (~17 query-uri DB
// + posibile apeluri API) la fiecare tap / refresh live. Key: h-a-fid.
// TTL: 60s live, 600s pre-meci/FT. Evicție FIFO la >200 intrări.
const enrichCache = new Map();
const ENRICH_TTL_LIVE   =  60_000;
const ENRICH_TTL_STATIC = 600_000;

// [SPEED A] Cache memorie pentru date FIXE intra-zi/intra-meci — rezultate
// IDENTICE cu calculul direct, doar fără re-rularea LATERAL-urilor grele:
//  • _avgStatsCache / _avgEventsCache: medii rolling-100 per (teamId, ziua
//    matchDate). Se schimbă doar la finalul unui meci al echipei → cheia pe
//    zi + invalidare zilnică e suficientă. (TĂIETURA 3)
//  • _h2hCache: H2H per pereche (min-max), TTL 3h — fix după kickoff. (TĂIETURA 4)
const _avgStatsCache  = new Map();   // `${teamId}|${YYYY-MM-DD}` → row|null
const _avgEventsCache = new Map();
const _h2hCache       = new Map();   // `${min}-${max}` → { v, ts }
const _AVG_CACHE_MAX  = 6000;
const _H2H_TTL        = 3 * 3600_000;
let   _avgCacheDay    = '';
function _dayOf(md) { return String(md || '').slice(0, 10) || new Date().toISOString().slice(0, 10); }
function _avgCachePrune() {
  // Invalidare zilnică (UTC) — la prima cerere a zilei noi golim cache-urile pe zi.
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _avgCacheDay) { _avgStatsCache.clear(); _avgEventsCache.clear(); _avgCacheDay = today; }
  if (_avgStatsCache.size  > _AVG_CACHE_MAX) _avgStatsCache.clear();
  if (_avgEventsCache.size > _AVG_CACHE_MAX) _avgEventsCache.clear();
}

// [C4] λ pre-calculat din tabela predictions (populat de collect-daily / enrich
// anterior). Folosit pentru a EVITA re-fetch-ul duplicat de formă + H2H din API
// (match.js le aduce deja). Returnează {lambda_home, lambda_away} sau null.
async function getLambdaFromPredictions(fixtureId) {
  if (!fixtureId) return null;
  try {
    const { rows } = await query(
      `SELECT lambda_home, lambda_away FROM predictions WHERE fixture_id = $1`,
      [Number(fixtureId)]
    );
    const r = rows[0];
    if (r && r.lambda_home != null && r.lambda_away != null) return r;
    return null;
  } catch (_) { return null; }
}

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

export function calcPoisson(hGames, aGames, h2h, hId, aId, elapsedParam, hgParam, agParam, sothParam, sotaParam, lgHome = 1.2, lgAway = 1.2, leagueStats = null) {
  // Sprint 4D — clamp scoruri extreme: orice meci cu total > 5 goluri
  // se tratează proporțional ca și cum totalul ar fi 5. Previne outliers
  // (ex: 6-0 demolare sau 5-3 carnaval) să infleze artificial lambdaHome/lambdaAway
  // și să distorsioneze attack/defense strength în Maher.
  const clampGoals = (m) => {
    const gh = m.goals?.home || 0;
    const ga = m.goals?.away || 0;
    const total = gh + ga;
    if (total <= 5) return m;
    const factor = 5 / total;
    return {
      ...m,
      goals: {
        ...m.goals,
        home: Math.round(gh * factor * 10) / 10,
        away: Math.round(ga * factor * 10) / 10,
      },
    };
  };
  hGames = hGames.map(clampGoals);
  aGames = aGames.map(clampGoals);

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

  let homeAvgScored   = weighted(hGames, m => (m.teams?.home?.id === hId ? m.goals?.home : m.goals?.away) ?? 0);
  let homeAvgConceded = weighted(hGames, m => (m.teams?.home?.id === hId ? m.goals?.away : m.goals?.home) ?? 0);
  let awayAvgScored   = weighted(aGames, m => (m.teams?.away?.id === aId ? m.goals?.away : m.goals?.home) ?? 0);
  let awayAvgConceded = weighted(aGames, m => (m.teams?.away?.id === aId ? m.goals?.home : m.goals?.away) ?? 0);

  // Shrinkage Bayesian — pull-uire spre media REALĂ a ligii (din league_stats).
  // Cu cât sample-ul de meciuri (hGames / aGames) e mai mic, cu atât ponderea
  // mediei ligii e mai mare. N_SHRINK=5 → la 5 meciuri form-ul contează 50%,
  // la 10 ~67%, la 20 ~80%. Aplicat DOAR când leagueStats furnizează valori
  // reale > 0 — niciodată cu constante hardcodate.
  const lgHomeReal = parseFloat(leagueStats?.avg_home_goals);
  const lgAwayReal = parseFloat(leagueStats?.avg_away_goals);
  if (Number.isFinite(lgHomeReal) && Number.isFinite(lgAwayReal) && lgHomeReal > 0 && lgAwayReal > 0) {
    const N_SHRINK = 5;
    const hK = hGames.length / (hGames.length + N_SHRINK);
    const aK = aGames.length / (aGames.length + N_SHRINK);
    homeAvgScored    = hK * homeAvgScored    + (1 - hK) * lgHomeReal;
    homeAvgConceded  = hK * homeAvgConceded  + (1 - hK) * lgAwayReal;
    awayAvgScored    = aK * awayAvgScored    + (1 - aK) * lgAwayReal;
    awayAvgConceded  = aK * awayAvgConceded  + (1 - aK) * lgHomeReal;
  }

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

// Clasifică o indisponibilitate după type/reason → severitatea penalizării:
//   'NATIONAL'     — reason conține 'national' → convocare națională, FĂRĂ penalizare
//   'OUT'          — type='Missing Fixture' (și nu national) → indisponibil cert (100%)
//   'QUESTIONABLE' — type='Questionable' SAU type/reason lipsă/altele → 50% penalizare
function classifyInjury(inj) {
  const type   = (inj && inj.type   != null ? String(inj.type)   : '').trim();
  const reason = (inj && inj.reason != null ? String(inj.reason) : '').trim().toLowerCase();
  if (reason.includes('national')) return 'NATIONAL';
  if (type === 'Missing Fixture')  return 'OUT';
  if (type === 'Questionable')     return 'QUESTIONABLE';
  return 'QUESTIONABLE';   // type/reason lipsă sau altele → tratează ca questionable
}

// Top-assist injury factor — dacă cel mai bun pasator decisiv al echipei (din
// top_assists) e accidentat (în array-ul `injuries`), atacul scade după severitate:
// OUT ×0.90, QUESTIONABLE ×0.95, NATIONAL/absent 1.0. Silent-fail → 1.0.
async function getTopAssistInjuryFactor(teamId, injuries) {
  if (!teamId) return 1.0;
  try {
    const { rows } = await query(
      `SELECT player_id, player_name, assists FROM top_assists
        WHERE team_id = $1 AND season = $2
        ORDER BY assists DESC LIMIT 1`,
      [Number(teamId), SEASON]
    );
    const top = rows[0];
    if (!top || top.player_id == null) return 1.0;
    const inj = Array.isArray(injuries)
      ? injuries.find(i => Number(i.player_id) === Number(top.player_id)) : null;
    if (!inj) return 1.0;
    const sev = classifyInjury(inj);
    if (sev === 'NATIONAL') return 1.0;       // convocare națională → fără penalizare
    if (sev === 'QUESTIONABLE') return 0.95;  // incert → jumătate de penalizare
    return 0.90;                              // OUT cert
  } catch (_) { return 1.0; }
}

// Top-scorer injury factor — dacă golgheterul #1 al echipei (din top_scorers)
// e accidentat (în array-ul `injuries`), atacul scade după severitate:
// OUT ×0.90, QUESTIONABLE ×0.95, NATIONAL/absent 1.0. Silent-fail → 1.0.
async function getTopScorerInjuryFactor(teamId, injuries) {
  if (!teamId) return 1.0;
  try {
    const { rows } = await query(
      `SELECT player_id, player_name, goals FROM top_scorers
        WHERE team_id = $1 AND season = $2
        ORDER BY goals DESC LIMIT 1`,
      [Number(teamId), SEASON]
    );
    const top = rows[0];
    if (!top || top.player_id == null) return 1.0;
    const inj = Array.isArray(injuries)
      ? injuries.find(i => Number(i.player_id) === Number(top.player_id)) : null;
    if (!inj) return 1.0;
    const sev = classifyInjury(inj);
    if (sev === 'NATIONAL') return 1.0;       // convocare națională → fără penalizare
    if (sev === 'QUESTIONABLE') return 0.95;  // incert → jumătate de penalizare
    return 0.90;                              // OUT cert
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
  // hasData (ADITIV): true DOAR când există formații reale cu ≥7/11 titulari
  // matchuiți pe ambele echipe. NU schimbă contractul home/away (factor pe λ).
  try {
    const { rows } = await query(
      `SELECT payload FROM prematch_data
       WHERE fixture_id=$1 AND data_type='lineups'
       ORDER BY stage DESC LIMIT 1`,
      [fixtureId]
    );
    if (!rows.length) return { home: 1.0, away: 1.0, hasData: false };
    const lineups = rows[0].payload;
    if (!Array.isArray(lineups) || lineups.length < 2) return { home: 1.0, away: 1.0, hasData: false };

    const findTeam = (id) => lineups.find(t => t.team?.id === id);
    const homeEntry = findTeam(homeId);
    const awayEntry = findTeam(awayId);
    if (!homeEntry || !awayEntry) return { home: 1.0, away: 1.0, hasData: false };

    const extractIds = (entry) =>
      (entry.startXI || []).map(p => p.player?.id).filter(Boolean);
    const hIds = extractIds(homeEntry);
    const aIds = extractIds(awayEntry);
    // ≥7/11 titulari pe AMBELE echipe = formații reale prezente.
    if (hIds.length < 7 || aIds.length < 7) return { home: 1.0, away: 1.0, hasData: false };

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
    if (hAvg == null && aAvg == null) return { home: 1.0, away: 1.0, hasData: false };

    const toFactor = (avg) =>
      avg != null ? Math.max(0.88, Math.min(1.12, avg / LINEUP_TEAM_AVG)) : 1.0;

    // hasData=true: formații reale (≥7/11 ambele) + cel puțin o echipă cu scoruri.
    return { home: toFactor(hAvg), away: toFactor(aAvg), hasData: true };
  } catch (_) { return { home: 1.0, away: 1.0, hasData: false }; }
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
      const sev = classifyInjury(inj);
      if (sev === 'NATIONAL') continue;   // convocare națională → nu contează
      const tid = Number(inj.team_id) || data.teamId;
      const entry = { id: inj.player_id, name: inj.player_name, score: data.score, severity: sev };
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
export function calcConfidencePreMatch(result, teamStrengths) {
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

  // ── score4 — Live xG/SOT/DA + NGP din live_stats DB + minute decay (Sprint Live) ──
  // Sume preferă per-team din live_stats; fallback la flat (din query params) pentru
  // backward compat dacă DB nu are date pentru fixture.
  const sumPair = (h, a, flat) => {
    const hh = h != null ? Number(h) : null;
    const aa = a != null ? Number(a) : null;
    if (hh != null || aa != null) return (hh || 0) + (aa || 0);
    return Number(flat || 0);
  };
  const totalXg  = sumPair(liveStats.home_xg,  liveStats.away_xg,  liveStats.xg);
  const totalSot = sumPair(liveStats.home_sot, liveStats.away_sot, liveStats.sot);
  const totalDa  = sumPair(liveStats.home_da,  liveStats.away_da,  liveStats.da);
  const elapsed  = liveStats.elapsed || 0;

  // NGP din DB — Next Goal Probability total (home + away), cap 100.
  const ngpH = liveStats.ngp_home != null ? Number(liveStats.ngp_home) : null;
  const ngpA = liveStats.ngp_away != null ? Number(liveStats.ngp_away) : null;
  let ngpVal = null;
  if (Number.isFinite(ngpH) || Number.isFinite(ngpA)) {
    ngpVal = Math.min(100,
      (Number.isFinite(ngpH) ? ngpH : 0) +
      (Number.isFinite(ngpA) ? ngpA : 0)
    );
  }

  let score4live;
  if (totalSot === 0 && elapsed > 10) {
    // Niciun șut la poartă în primele 10 min → meci închis.
    score4live = 20;
  } else {
    // Componenta intensity: xG dominant, SOT secundar, DA terțiar.
    const intensity = Math.min(100, totalXg * 25 + totalSot * 3 + totalDa * 0.5);
    // Blend cu NGP din DB (model dedicat next-goal): 60% intensity + 40% NGP.
    const blended = ngpVal != null ? (intensity * 0.6 + ngpVal * 0.4) : intensity;
    // Minute decay: după min 75, oportunitățile rămase scad liniar până la 0.7 la min 90.
    const decay = elapsed > 75 ? Math.max(0.7, 1 - (elapsed - 75) / 50) : 1.0;
    score4live = Math.max(0, Math.min(100, blended * decay));
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
  // [SPEED A T4] H2H e fix după kickoff → cache per pereche (TTL 3h). Rezultat identic.
  const _hk = (homeId && awayId) ? `${Math.min(homeId, awayId)}-${Math.max(homeId, awayId)}` : null;
  if (_hk) { const e = _h2hCache.get(_hk); if (e && Date.now() - e.ts < _H2H_TTL) return e.v; }
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
      // Query ÎMBOGĂȚIT: scor final + HT + evenimente (goluri/cartonașe) + statistici
      // per echipă, agregate ca JSON per fixture. fixtures_history are home_ht/away_ht
      // (NU home_goals_ht) — aliasate la home_goals_ht/away_goals_ht.
      const fh = await query(
        `SELECT
           fh.fixture_id, fh.match_date,
           fh.home_team_name, fh.away_team_name,
           fh.home_team_id, fh.away_team_id,
           fh.home_goals, fh.away_goals,
           fh.home_ht AS home_goals_ht, fh.away_ht AS away_goals_ht,
           fh.status_short, fh.league_id, fh.season,
           COALESCE(
             json_agg(
               DISTINCT jsonb_build_object(
                 'elapsed', me.elapsed,
                 'team_id', me.team_id,
                 'team_name', me.team_name,
                 'player', me.player_name,
                 'assist', me.assist_name,
                 'type', me.type,
                 'detail', me.detail
               )
             ) FILTER (WHERE me.id IS NOT NULL AND me.type IN ('Goal','Card')),
             '[]'
           ) AS events,
           COALESCE(
             json_agg(
               DISTINCT jsonb_build_object(
                 'team_id', ms.team_id,
                 'team_name', ms.team_name,
                 'shots_on_goal', ms.shots_on_goal,
                 'shots_total', ms.shots_total,
                 'corner_kicks', ms.corner_kicks,
                 'ball_possession', ms.ball_possession,
                 'yellow_cards', ms.yellow_cards,
                 'red_cards', ms.red_cards,
                 'expected_goals', ms.expected_goals,
                 'passes_accurate', ms.passes_accurate,
                 'pass_percentage', ms.pass_percentage
               )
             ) FILTER (WHERE ms.id IS NOT NULL),
             '[]'
           ) AS stats
         FROM fixtures_history fh
         LEFT JOIN match_events me ON me.fixture_id = fh.fixture_id
         LEFT JOIN match_stats ms ON ms.fixture_id = fh.fixture_id
         WHERE ((fh.home_team_id = $1 AND fh.away_team_id = $2)
             OR (fh.home_team_id = $2 AND fh.away_team_id = $1))
           AND fh.status_short IN ('FT','AET','PEN')
           AND fh.home_goals IS NOT NULL
         GROUP BY fh.fixture_id, fh.match_date, fh.home_team_name,
           fh.away_team_name, fh.home_team_id, fh.away_team_id,
           fh.home_goals, fh.away_goals, fh.home_ht,
           fh.away_ht, fh.status_short, fh.league_id, fh.season
         ORDER BY fh.match_date DESC
         LIMIT 10`,
        [homeId, awayId]
      );
      // Dedupe după fixture_id (cheie unică), păstrând prioritate h2h table (sursa primară)
      const seenFids = new Set(h2hRows.map(r => r.fixture_id).filter(v => v != null));
      for (const row of fh.rows) {
        if (row.fixture_id != null && seenFids.has(row.fixture_id)) continue;
        // Câmpuri NOI (nested) — păstrând TOATE câmpurile flat existente (backwards-compat).
        row.home_team = { id: row.home_team_id, name: row.home_team_name };
        row.away_team = { id: row.away_team_id, name: row.away_team_name };
        row.score     = { home: row.home_goals ?? 0, away: row.away_goals ?? 0 };
        row.score_ht  = (row.home_goals_ht != null || row.away_goals_ht != null)
          ? { home: row.home_goals_ht, away: row.away_goals_ht } : null;
        row.status    = row.status_short;
        row.events    = Array.isArray(row.events) ? row.events : [];
        row.stats     = Array.isArray(row.stats) ? row.stats : [];
        h2hRows.push(row);
      }
      // Re-sortare DESC după match_date + cap la 10
      h2hRows.sort((a, b) => new Date(b.match_date) - new Date(a.match_date));
      h2hRows = h2hRows.slice(0, 10);
    } catch (_) { /* păstrează h2hRows existent */ }
  }

  if (_hk) { if (_h2hCache.size > 2000) _h2hCache.clear(); _h2hCache.set(_hk, { v: h2hRows, ts: Date.now() }); }
  return h2hRows;
}

// Cache injuries — 30 min per fixture (nu se schimbă des). { [fid]: {ts, data} }
const _injuriesCache = new Map();
const INJURIES_TTL = 30 * 60 * 1000;

// Sursă PRINCIPALĂ injuries: fetch LIVE din API-Football pentru ACEST fixture.
// Rezolvă „24 accidentați": DB acumula jucători din meciuri anterioare (recuperați
// rămâneau marcați). API /injuries?fixture=X întoarce DOAR indisponibilii reali
// pentru acest meci. Fallback la getInjuriesFromDB dacă API gol/eroare.
async function getInjuries(fixtureId) {
  if (!fixtureId) return [];
  const fid = Number(fixtureId);
  const c = _injuriesCache.get(fid);
  if (c && Date.now() - c.ts < INJURIES_TTL) return c.data;

  try {
    const r = await fetchApiFootball(`/injuries?fixture=${fid}`);
    const data = await r.json();
    const list = data.response || [];
    const mapped = list
      .map(item => {
        const o = {
          fixture_id:  fid,
          team_id:     item.team?.id     || null,
          team_name:   item.team?.name   || null,
          player_id:   item.player?.id   || null,
          player_name: item.player?.name || null,
          type:        item.player?.type || null,
          reason:      item.player?.reason || null,
        };
        o.severity = classifyInjury(o);
        return o;
      })
      // Exclude inactivii + convocările la națională (fără penalizare). Păstrează
      // OUT cert ȘI Questionable (acesta din urmă → penalizare redusă în aval).
      .filter(p => {
        const reason = (p.reason || '').trim().toLowerCase();
        if (reason === 'inactiv' || reason === 'inactive') return false;
        if (p.severity === 'NATIONAL') return false;
        return true;
      });
    if (mapped.length > 0) {
      _injuriesCache.set(fid, { ts: Date.now(), data: mapped });
      return mapped;
    }
    // API gol → fallback DB
    const dbFallback = await getInjuriesFromDB(fid);
    _injuriesCache.set(fid, { ts: Date.now(), data: dbFallback });
    return dbFallback;
  } catch (_) {
    // Eroare API → fallback DB (fără cache, ca să reîncerce API data viitoare)
    return await getInjuriesFromDB(fid);
  }
}

async function getInjuriesFromDB(fixtureId) {
  try {
    // Filtru type: doar indisponibili REALI (accidentați / absenți), NU întreg
    // cumulul sezonier raportat de API. Cap 15/echipă ca plasă de siguranță.
    const r = await query(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY player_id) AS _rn
           FROM injuries
          WHERE fixture_id = $1
            AND (type IS NULL OR type IN ('Missing Fixture', 'Injured', 'Injury', 'Questionable'))
       ) q WHERE _rn <= 15`,
      [fixtureId]
    );
    if (r.rows.length > 0) {
      return r.rows
        .map(row => ({ ...row, severity: classifyInjury(row) }))
        .filter(p => p.severity !== 'NATIONAL');
    }

    // Fallback: prematch_data stochează injuries ca array JSON brut
    const pd = await query(
      `SELECT payload FROM prematch_data WHERE fixture_id = $1 AND data_type = 'injuries'
       ORDER BY collected_at DESC LIMIT 1`,
      [fixtureId]
    );
    if (!pd.rows.length) return [];
    const arr = pd.rows[0].payload;
    if (!Array.isArray(arr)) return [];
    return arr.map(item => {
      const o = {
        fixture_id:  fixtureId,
        team_id:     item.team?.id    || null,
        team_name:   item.team?.name  || null,
        player_id:   item.player?.id  || null,
        player_name: item.player?.name || null,
        type:        item.player?.type || null,
        reason:      item.player?.reason || null,
      };
      o.severity = classifyInjury(o);
      return o;
    }).filter(p => p.severity !== 'NATIONAL');
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

// Poziție normalizată (rank-1)/(max_rank-1) per echipă din standings (sezonul
// cel mai recent al ligii). Snapshot CURENT (aproximare; standings nu e istoric).
// Folosit DOAR ca feature ML (live v2 + pre-meci). NU atinge scoring/lambda.
async function getPositionNorms(hId, aId, leagueId) {
  if (!leagueId || !hId || !aId) return { home: null, away: null };
  try {
    const { rows } = await query(
      `SELECT team_id, MIN(rank) AS rank, MAX(MIN(rank)) OVER () AS max_rank
         FROM standings
        WHERE league_id = $1
          AND season = (SELECT MAX(season) FROM standings WHERE league_id = $1)
        GROUP BY team_id`,
      [Number(leagueId)]
    );
    const norm = (rank, mx) =>
      (rank != null && mx != null && mx > 1) ? +(((rank - 1) / (mx - 1)).toFixed(4)) : null;
    let home = null, away = null;
    for (const r of rows) {
      const v = norm(Number(r.rank), Number(r.max_rank));
      if (Number(r.team_id) === Number(hId)) home = v;
      if (Number(r.team_id) === Number(aId)) away = v;
    }
    return { home, away };
  } catch (_) { return { home: null, away: null }; }
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
                  played_home, played_away,
                  goals_for_home, goals_for_away,
                  goals_against_home, goals_against_away
           FROM teams_stats WHERE team_id = $1 AND league_id = $2
           ORDER BY season DESC LIMIT 1`,
          [teamId, Number(leagueId)]
        )
      : await query(
          `SELECT avg_goals_for, avg_goals_against,
                  clean_sheets_home, clean_sheets_away,
                  played_home, played_away,
                  goals_for_home, goals_for_away,
                  goals_against_home, goals_against_away
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

// Sprint Live — Citește ULTIMA înregistrare live_stats pentru un fixture.
// Toate coloanele provin EXCLUSIV din DB (zero query params, zero hardcoded).
// Folosit în score4 din calcConfidenceLive pentru intensity + NGP + decay.
async function getLiveStatsFromDB(fixtureId) {
  if (!fixtureId) return null;
  try {
    const r = await query(
      `SELECT elapsed, home_goals, away_goals,
              home_sot, away_sot,
              home_shots, away_shots,
              home_possession, away_possession,
              home_da, away_da,
              home_xg, away_xg,
              ngp_home, ngp_away,
              recorded_at
         FROM live_stats
        WHERE fixture_id = $1
        ORDER BY recorded_at DESC
        LIMIT 1`,
      [Number(fixtureId)]
    );
    return r.rows[0] || null;
  } catch (_) { return null; }
}

// Medii istorice match_stats — ultimele 100 meciuri ALE echipei cu match_date <
// matchDate (FĂRĂ lookahead, ALINIAT cu build-ml-features.js / train_model.py).
// Furnizate ca features ML (homeXgAvg etc.) către api/ml-predict.js.
// Silent-fail → null (ml-predict cade pe mediană).
async function getMatchStatsAvg(teamId, matchDate) {
  if (!teamId || !matchDate) return null;
  _avgCachePrune();
  const _ck = `${teamId}|${_dayOf(matchDate)}`;
  if (_avgStatsCache.has(_ck)) return _avgStatsCache.get(_ck);
  try {
    const { rows } = await query(
      `SELECT
          AVG(ms.shots_on_goal)   AS sot_avg,
          AVG(ms.corner_kicks)    AS corners_avg,
          AVG(ms.expected_goals)  AS xg_avg,
          AVG(ms.yellow_cards)    AS yc_avg,
          AVG(ms.red_cards)       AS rc_avg,
          AVG(ms.fouls)           AS fouls_avg,
          AVG(ms.shots_insidebox) AS insidebox_avg,
          AVG(ms.ball_possession) AS possession_avg
       FROM (
          SELECT ms.* FROM match_stats ms
          JOIN fixtures_history fhx ON fhx.fixture_id = ms.fixture_id
          WHERE ms.team_id = $1 AND fhx.match_date < $2
          ORDER BY fhx.match_date DESC LIMIT 100
       ) ms`,
      [Number(teamId), matchDate]
    );
    const _v = rows[0] || null;
    _avgStatsCache.set(_ck, _v);
    return _v;
  } catch (_) { return null; }
}

// Medii istorice match_events — goluri R1/R2 + substituiri, ultimele 100 meciuri
// ANTERIOARE ale echipei (FĂRĂ lookahead). Query IDENTIC cu LATERAL meh/mea din
// api/cron/build-ml-features.js (sursă canonică). Silent-fail → null.
async function getMatchEventsAvg(teamId, matchDate) {
  if (!teamId || !matchDate) return null;
  _avgCachePrune();
  const _ck = `${teamId}|${_dayOf(matchDate)}`;
  if (_avgEventsCache.has(_ck)) return _avgEventsCache.get(_ck);
  try {
    const { rows } = await query(
      `SELECT
          AVG(CASE WHEN g.r1_goals IS NOT NULL THEN g.r1_goals ELSE 0 END) AS goals_r1_avg,
          AVG(CASE WHEN g.r2_goals IS NOT NULL THEN g.r2_goals ELSE 0 END) AS goals_r2_avg,
          AVG(g.subs) AS subs_avg
       FROM (
          SELECT fhx.fixture_id,
              SUM(CASE WHEN me.type='Goal' AND me.elapsed<=45 AND me.team_id=$1 THEN 1 ELSE 0 END) AS r1_goals,
              SUM(CASE WHEN me.type='Goal' AND me.elapsed>45 AND me.team_id=$1 THEN 1 ELSE 0 END) AS r2_goals,
              SUM(CASE WHEN me.type='subst' AND me.team_id=$1 THEN 1 ELSE 0 END) AS subs
          FROM fixtures_history fhx
          JOIN match_events me ON me.fixture_id=fhx.fixture_id
          WHERE (fhx.home_team_id=$1 OR fhx.away_team_id=$1)
            AND fhx.match_date < $2
          GROUP BY fhx.fixture_id
          ORDER BY MAX(fhx.match_date) DESC LIMIT 100
       ) g`,
      [Number(teamId), matchDate]
    );
    const _v = rows[0] || null;
    _avgEventsCache.set(_ck, _v);
    return _v;
  } catch (_) { return null; }
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

  // [C3] Cache lookup — live (elapsed>0 / status live) = TTL scurt, altfel lung.
  // `force=1` ocolește DOAR cache-ul (re-enrich țintit) — NU schimbă scoringul.
  const _force = req.query?.force === '1' || req.query?.force === 1;
  const _isLiveReq = (parseInt(elapsed) || 0) > 0 || LIVE_STATUSES.has(status_short);
  const _tEnrich = Date.now();   // [SPEED A] cronometrare enrich (vizibil în pm2 logs)
  const cacheKey = `${hId}-${aId}-${fid || 0}`;
  const _cached = enrichCache.get(cacheKey);
  if (!_force && _cached && Date.now() - _cached.ts < (_isLiveReq ? ENRICH_TTL_LIVE : ENRICH_TTL_STATIC)) {
    if (_isLiveReq) console.log(`[enrich] fid=${fid || '-'} CACHE-HIT ${Date.now() - _tEnrich}ms`);
    return res.status(200).json(_cached.data);
  }

  try {
    // --- Batch 1: DB queries + team strengths + injuries + match_stats + venue in parallel ---
    const _avgDate = dt || new Date().toISOString();
    const [sbHForm, sbAForm, sbH2H, teamStrengths, injuries, matchStats, leagueStats, refereeStats, venueInfo, stnH, stnA, apiPred, topScorerFactorH, topScorerFactorA, squadCntH, squadCntA, lineupFactor, dbLambda, mshAvg, msaAvg, mehAvg, meaAvg] = await Promise.all([
      getHomeForm(hId),
      getAwayForm(aId),
      getH2HFromDB(hId, aId),
      getTeamStrengths(hId, aId),
      fid ? getInjuries(Number(fid)) : Promise.resolve([]),
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
      getLambdaFromPredictions(fid),
      getMatchStatsAvg(hId, _avgDate),
      getMatchStatsAvg(aId, _avgDate),
      getMatchEventsAvg(hId, _avgDate),
      getMatchEventsAvg(aId, _avgDate),
    ]);

    // [C4] Dacă predictions DB are λ (collect-daily) → NU mai re-fetch-uim formă
    // + H2H din API (match.js le aduce deja). Folosim doar datele DB existente
    // și suprascriem λ din predictions mai jos. Elimină apelurile API duplicate.
    const havePred = dbLambda && dbLambda.lambda_home != null && dbLambda.lambda_away != null;

    // --- Batch 2: API-Football fallbacks only where DB had insufficient data ---
    const needHForm = !havePred && sbHForm.length  < 3;
    const needAForm = !havePred && sbAForm.length  < 3;
    const needH2H   = !havePred && sbH2H.length    < 3;

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
      // Split venue-specific: gazda folosește rata ACASĂ, oaspetele rata în
      // DEPLASARE. Fallback la media globală dacă played_home/away=0 sau lipsă.
      const homeRate = (tsH && Number(tsH.played_home) > 0 && tsH.goals_for_home != null)
        ? Number(tsH.goals_for_home) / Number(tsH.played_home) : tsHScored;
      const awayRate = (tsA && Number(tsA.played_away) > 0 && tsA.goals_for_away != null)
        ? Number(tsA.goals_for_away) / Number(tsA.played_away) : tsAScored;
      const homeDefRate = (tsH && Number(tsH.played_home) > 0 && tsH.goals_against_home != null)
        ? Number(tsH.goals_against_home) / Number(tsH.played_home) : tsHConceded;
      const awayDefRate = (tsA && Number(tsA.played_away) > 0 && tsA.goals_against_away != null)
        ? Number(tsA.goals_against_away) / Number(tsA.played_away) : tsAConceded;
      if (homeRate != null && awayDefRate != null)
        result.lambdaHome = +((homeRate + awayDefRate) / 2).toFixed(2);
      if (awayRate != null && homeDefRate != null)
        result.lambdaAway = +((awayRate + homeDefRate) / 2).toFixed(2);
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

    // [C4] λ din predictions (collect-daily) — sursă unică când forma lipsește
    // și am sărit fetch-ul API (havePred). Aplicat înainte de topscorer/venue
    // (care îl ajustează mai jos). Când forma EXISTĂ, lăsăm pipeline-ul complet.
    if (havePred && formInsufficient) {
      const r2 = v => +(Number(v)).toFixed(2);
      result.lambdaHome  = r2(dbLambda.lambda_home);
      result.lambdaAway  = r2(dbLambda.lambda_away);
      result.lambdaTotal = r2(result.lambdaHome + result.lambdaAway);
      const mxL = calcPoisson6x6(result.lambdaHome, result.lambdaAway);
      Object.assign(result, {
        over15Prob: mxL.over15Prob, over25Prob: mxL.over25Prob,
        ggProb: mxL.ggProb, homeWin: mxL.homeWin, draw: mxL.draw, awayWin: mxL.awayWin,
      });
      result._lambdaFromPredictions = true;
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

    // Baseline λ înainte de lanțul de factori multiplicativi (după Maher + h2h
    // blend / teams_stats override / standings). Referință pt clamp-ul de mai jos.
    const lambdaHomeBaseline = result.lambdaHome;
    const lambdaAwayBaseline = result.lambdaAway;

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

    // Top-assist injury factor — pasatorul decisiv #1 accidentat → λ ×0.90 (±10% max).
    // Folosește array-ul `injuries` deja adus în pipeline (silent-fail → 1.0).
    let topAssistFactorH = 1.0, topAssistFactorA = 1.0;
    try {
      [topAssistFactorH, topAssistFactorA] = await Promise.all([
        getTopAssistInjuryFactor(hId, injuries),
        getTopAssistInjuryFactor(aId, injuries),
      ]);
    } catch (_) { /* silent */ }
    if (topAssistFactorH !== 1.0 || topAssistFactorA !== 1.0) {
      result.lambdaHome  = +(result.lambdaHome  * topAssistFactorH).toFixed(2);
      result.lambdaAway  = +(result.lambdaAway  * topAssistFactorA).toFixed(2);
      result.lambdaTotal = +(result.lambdaHome + result.lambdaAway).toFixed(2);
      const mxTaf = calcPoisson6x6(result.lambdaHome, result.lambdaAway);
      Object.assign(result, {
        over15Prob: mxTaf.over15Prob, over25Prob: mxTaf.over25Prob,
        ggProb: mxTaf.ggProb, homeWin: mxTaf.homeWin,
        draw: mxTaf.draw, awayWin: mxTaf.awayWin,
      });
      result._topAssistFactor = `H:${topAssistFactorH.toFixed(2)}|A:${topAssistFactorA.toFixed(2)}`;
    }

    // Top-scorer injury factor — golgheterul #1 accidentat → λ ×0.90 (±10% max).
    // Folosește array-ul `injuries` deja adus în pipeline (silent-fail → 1.0).
    let topScorerInjuryFactorH = 1.0, topScorerInjuryFactorA = 1.0;
    try {
      [topScorerInjuryFactorH, topScorerInjuryFactorA] = await Promise.all([
        getTopScorerInjuryFactor(hId, injuries),
        getTopScorerInjuryFactor(aId, injuries),
      ]);
    } catch (_) { /* silent */ }
    if (topScorerInjuryFactorH !== 1.0 || topScorerInjuryFactorA !== 1.0) {
      result.lambdaHome  = +(result.lambdaHome  * topScorerInjuryFactorH).toFixed(2);
      result.lambdaAway  = +(result.lambdaAway  * topScorerInjuryFactorA).toFixed(2);
      result.lambdaTotal = +(result.lambdaHome + result.lambdaAway).toFixed(2);
      const mxTsi = calcPoisson6x6(result.lambdaHome, result.lambdaAway);
      Object.assign(result, {
        over15Prob: mxTsi.over15Prob, over25Prob: mxTsi.over25Prob,
        ggProb: mxTsi.ggProb, homeWin: mxTsi.homeWin,
        draw: mxTsi.draw, awayWin: mxTsi.awayWin,
      });
      result._topScorerInjuryFactor = `H:${topScorerInjuryFactorH.toFixed(2)}|A:${topScorerInjuryFactorA.toFixed(2)}`;
    }

    // Smart injury lambda penalty — jucători importanți lipsă reduc puterea de atac
    if (fid && Array.isArray(injuries) && injuries.length > 0) {
      const baseInjFactor = (score) => {
        if (score > 80) return 0.88;
        if (score > 65) return 0.94;
        if (score > 45) return 0.97;
        return 1.0;
      };
      // Per jucător: factor după importanță, ajustat pe severitate (OUT 100%,
      // QUESTIONABLE 50%, NATIONAL exclus). Reține cea mai puternică penalizare.
      const applyInjLambda = (players) => {
        if (!players.length) return 1.0;
        let factor = 1.0;
        for (const p of players) {
          if (p.severity === 'NATIONAL') continue;
          let f = baseInjFactor(p.score);
          if (p.severity === 'QUESTIONABLE') f = 1 - (1 - f) / 2;  // jumătate de penalizare
          if (f < factor) factor = f;
        }
        return factor;
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

    // Clamp global — produsul factorilor (top scorer/lineup/top assist/injury
    // accidentări) nu poate scădea λ sub LAMBDA_MIN_RATIO din baseline → evită
    // over-deflation (worst-case stacking ~0.71×). Aplicat ÎNAINTE de
    // model-weights multiplier (calibrarea învățată rămâne autoritativă).
    const LAMBDA_MIN_RATIO = 0.65;
    const prevClampH = result.lambdaHome, prevClampA = result.lambdaAway;
    result.lambdaHome = Math.max(result.lambdaHome, +(lambdaHomeBaseline * LAMBDA_MIN_RATIO).toFixed(2));
    result.lambdaAway = Math.max(result.lambdaAway, +(lambdaAwayBaseline * LAMBDA_MIN_RATIO).toFixed(2));
    if (result.lambdaHome !== prevClampH || result.lambdaAway !== prevClampA) {
      result.lambdaTotal = +(result.lambdaHome + result.lambdaAway).toFixed(2);
      const mxClamp = calcPoisson6x6(result.lambdaHome, result.lambdaAway);
      Object.assign(result, {
        over15Prob: mxClamp.over15Prob, over25Prob: mxClamp.over25Prob,
        ggProb: mxClamp.ggProb, homeWin: mxClamp.homeWin,
        draw: mxClamp.draw, awayWin: mxClamp.awayWin,
      });
      result._lambdaClamped = true;
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

    // Sprint Live — Citește live_stats real din DB (preferă față de query params).
    // Doar dacă caller-ul a semnalat live mode (elapsedNum > 0) — altfel pre-meci.
    const liveDB = (fid && elapsedNum > 0)
      ? await getLiveStatsFromDB(Number(fid))
      : null;

    const liveStats = elapsedNum > 0 ? {
      // Sume folosite în score4 (DB > query params fallback)
      xg:  liveDB ? (Number(liveDB.home_xg || 0) + Number(liveDB.away_xg || 0)) : xgValue,
      sot: liveDB ? (Number(liveDB.home_sot || 0) + Number(liveDB.away_sot || 0))
                   : ((parseInt(soth) || 0) + (parseInt(sota) || 0)),
      da:  liveDB ? (Number(liveDB.home_da || 0) + Number(liveDB.away_da || 0)) : da,
      yc,
      elapsed: liveDB?.elapsed ?? elapsedNum,
      // Detalii per echipă + NGP (din DB) — folosite în score4 (fallback null)
      home_xg:  liveDB?.home_xg  ?? null,
      away_xg:  liveDB?.away_xg  ?? null,
      home_sot: liveDB?.home_sot ?? null,
      away_sot: liveDB?.away_sot ?? null,
      home_da:  liveDB?.home_da  ?? null,
      away_da:  liveDB?.away_da  ?? null,
      ngp_home: liveDB?.ngp_home ?? null,
      ngp_away: liveDB?.ngp_away ?? null,
      _source:  liveDB ? 'live_stats' : 'query',
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

    // Guard date insuficiente — penalizare graduală când predicția se sprijină pe
    // puține surse reale (H2H <3, fără score7/putere echipe, formă insuficientă).
    // NU atinge calcConfidence*/score1-7; doar ajustează confidenceScore (handler).
    const thinDataFlags = [
      result.h2hSample < 3,                 // H2H insuficient
      !confData.breakdown?.putereEchipe,    // score7 null (lipsă teamStrengths)
      formInsufficient,                     // formă insuficientă (hGames<3 || aGames<3)
    ];
    const thinCount = thinDataFlags.filter(Boolean).length;
    if (thinCount >= 2) {
      const thinPenalty = thinCount === 3 ? 15 : 8;
      confData.confidenceScore = Math.max(10, confData.confidenceScore - thinPenalty);
      confData._thinData = true;
      confData._thinCount = thinCount;
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

    // ── Tagging ADITIV (variant A) — NU atinge scoringul ────────────────────
    // playerIntelActive = avem semnal real de jucători pentru ACEST meci:
    //   score7 (Putere Echipe din player_stats) non-null PENTRU AMBELE echipe
    //   ȘI formații reale prezente (lineupFactor.hasData = ≥7/11 titulari ambele).
    // dataCompleteness = 'complete' când playerIntelActive, altfel 'partial'.
    // Derivat DOAR din date deja aduse în pipeline (teamStrengths + lineupFactor),
    // zero apeluri API noi, zero decizie hardcodată pe ligă.
    const _strBoth = confData.teamStrengthHome != null && confData.teamStrengthAway != null;
    const _lineupsReal = !!(lineupFactor && lineupFactor.hasData);
    const playerIntelActive = _strBoth && _lineupsReal;
    const dataCompleteness  = playerIntelActive ? 'complete' : 'partial';

    // Medii istorice (match_stats) + arbitru → features ML (citite de
    // ml-predict.js; lipsă/null → mediană default, fără crash).
    const _r2v = (v) => { const n = Number(v); return Number.isFinite(n) ? +n.toFixed(2) : null; };
    if (mshAvg) {
      result.homeSotAvg       = _r2v(mshAvg.sot_avg);
      result.homeCornersAvg   = _r2v(mshAvg.corners_avg);
      result.homeXgAvg        = _r2v(mshAvg.xg_avg);
      result.homeYcAvg        = _r2v(mshAvg.yc_avg);
      result.homeRcAvg        = _r2v(mshAvg.rc_avg);
      result.homeFoulsAvg     = _r2v(mshAvg.fouls_avg);
      result.homeInsideboxAvg = _r2v(mshAvg.insidebox_avg);
      result.homePossessionAvg = _r2v(mshAvg.possession_avg);
    }
    if (msaAvg) {
      result.awaySotAvg       = _r2v(msaAvg.sot_avg);
      result.awayCornersAvg   = _r2v(msaAvg.corners_avg);
      result.awayXgAvg        = _r2v(msaAvg.xg_avg);
      result.awayYcAvg        = _r2v(msaAvg.yc_avg);
      result.awayRcAvg        = _r2v(msaAvg.rc_avg);
      result.awayFoulsAvg     = _r2v(msaAvg.fouls_avg);
      result.awayInsideboxAvg = _r2v(msaAvg.insidebox_avg);
      result.awayPossessionAvg = _r2v(msaAvg.possession_avg);
    }
    if (mehAvg) {
      result.homeGoalsR1Avg = _r2v(mehAvg.goals_r1_avg);
      result.homeGoalsR2Avg = _r2v(mehAvg.goals_r2_avg);
      result.homeSubsAvg    = _r2v(mehAvg.subs_avg);
    }
    if (meaAvg) {
      result.awayGoalsR1Avg = _r2v(meaAvg.goals_r1_avg);
      result.awayGoalsR2Avg = _r2v(meaAvg.goals_r2_avg);
      result.awaySubsAvg    = _r2v(meaAvg.subs_avg);
    }
    if (refereeStats) {
      result.refPctOver25 = _r2v(refereeStats.pct_over_25);
      result.refStyleOpen = refereeStats.referee_style === 'open' ? 1 : 0;
      result.refYcAvg     = _r2v(refereeStats.avg_yellow_cards);   // feature ML live v2
    }

    // Poziție normalizată (feature ML: live v2 + pre-meci). ADITIV, fără scoring.
    try {
      const _pos = await getPositionNorms(hId, aId, lgid);
      result.homePositionNorm = _pos.home;
      result.awayPositionNorm = _pos.away;
    } catch (_) { /* poziție indisponibilă → null → mediană la inferență */ }

    const payload = { ...result, ...confData,
      playerIntelActive, dataCompleteness,
      cardsOver35, cardsOver45, cornersOver85, cornersOver95,
      leagueStats: leagueStats || null, refereeStats: refereeStats || null,
      // Sprint expune-date: h2hForm — ultimele 5 meciuri H2H pentru display.
      // Sursa primară: sbH2H (h2h table + fixtures_history fallback).
      // Numele echipelor sunt derivate prin team_id față de hId/aId actuali.
      h2hForm: (Array.isArray(sbH2H) ? sbH2H : []).slice(0, 5).map(row => ({
        // câmpurile EXISTENTE — NEATINSE (orientare după team-id față de hId/aId)
        date:      row.match_date,
        homeTeam:  row.home_team_id === hId ? (hn || 'Gazde')    : (an || 'Oaspeți'),
        awayTeam:  row.away_team_id === aId ? (an || 'Oaspeți')  : (hn || 'Gazde'),
        homeGoals: row.home_goals ?? 0,
        awayGoals: row.away_goals ?? 0,
        // CÂMPURI NOI — date bogate din getH2HFromDB
        score_ht:      row.score_ht || null,
        events:        row.events || [],
        stats:         row.stats || [],
        // team-id-uri pt alinierea home/away a evenimentelor în UI (aditiv, non-breaking)
        home_team_id:  row.home_team_id,
        away_team_id:  row.away_team_id,
      })),
    };

    // ── ELO BLEND post-scoring (sesiune dedicată, aprobat Vlad) ──────────────
    // Ajustare DOAR pe over15Prob / ggProb / homeWin, folosind ELO pre-meci
    // (elo_history, point-in-time, fără lookahead). NU atinge score1-7 /
    // calcConfidence* (acelea rămân intacte). Dacă ELO lipsește sau flag off →
    // predicție NESCHIMBATĂ. Marchează payload.eloAdjusted / eloDiffUsed.
    const USE_ELO_BLEND = true;
    let eloResult = null;   // {home_elo,away_elo,elo_diff,home_win_prob} pt ML/UI
    if (USE_ELO_BLEND && fid) {
      try {
        let eloDiff = null, hwpElo = null;
        // 1) elo_history pe fixture (meciuri trecute/backtest — point-in-time).
        const eloRes = await query(
          `SELECT home_elo, away_elo, elo_diff, home_win_prob FROM elo_history WHERE fixture_id = $1`,
          [Number(fid)]
        );
        const er = eloRes.rows[0];
        if (er) {
          eloDiff = Number(er.elo_diff);
          hwpElo  = Number(er.home_win_prob);   // 0..1
          eloResult = { home_elo: Number(er.home_elo), away_elo: Number(er.away_elo), elo_diff: eloDiff, home_win_prob: hwpElo };
        } else if (hId && aId && lgid) {
          // 2) Fallback elo_ratings (meciuri VIITOARE / NS — fără snapshot în history).
          const rr = await query(
            `SELECT er_h.elo AS home_elo, er_h.games AS home_games,
                    er_a.elo AS away_elo, er_a.games AS away_games
               FROM elo_ratings er_h
               JOIN elo_ratings er_a ON er_a.team_id = $2 AND er_a.league_id = $3
              WHERE er_h.team_id = $1 AND er_h.league_id = $3`,
            [Number(hId), Number(aId), Number(lgid)]
          );
          const r2 = rr.rows[0];
          // Skip blend dacă vreo echipă are < 10 meciuri (ELO neîncrezător).
          if (r2 && Number(r2.home_games) >= 10 && Number(r2.away_games) >= 10) {
            eloDiff = Number(r2.home_elo) - Number(r2.away_elo);
            hwpElo  = 1 / (1 + Math.pow(10, -eloDiff / 400));
            eloResult = { home_elo: Number(r2.home_elo), away_elo: Number(r2.away_elo), elo_diff: eloDiff, home_win_prob: hwpElo };
          }
        }

        if (eloDiff != null) {
          const balanced = Math.abs(eloDiff) <= 100;
          // A) Over 1.5
          if (payload.over15Prob != null) {
            const base = balanced ? 74.1 : 86.6;
            payload.over15Prob = Math.round(payload.over15Prob * 0.85 + base * 0.15);
          }
          // B) GG
          if (payload.ggProb != null) {
            const base = balanced ? 50.0 : 61.9;
            payload.ggProb = Math.round(payload.ggProb * 0.85 + base * 0.15);
          }
          // C) Home Win — doar când home e favorit (eloDiff > 0)
          if (payload.homeWin != null && eloDiff > 0 && Number.isFinite(hwpElo)) {
            payload.homeWin = (eloDiff > 100)
              ? Math.round(payload.homeWin * 0.80 + hwpElo * 100 * 0.20)
              : Math.round(payload.homeWin * 0.85 + hwpElo * 100 * 0.15);
          }
          payload.eloAdjusted = true;
          payload.eloDiffUsed = +eloDiff.toFixed(2);
        }
      } catch (_) { /* ELO indisponibil → predicție neschimbată */ }
    }

    // ── ML PREDICTIONS (afișare suplimentară; NU atinge scoring) ──────────────
    // Inferență LR din ml/model_export.json. Silent-fail dacă exportul lipsește.
    try {
      const mlPredictions = predictAllMarkets(payload, eloResult);
      if (mlPredictions) {
        payload.mlPredictions = mlPredictions;
        payload.mlAvailable = true;
      }
    } catch (_) { /* ML indisponibil → fără tab ML */ }

    // ── ML LIVE v2 (model_live_export.json) — DOAR meciuri în desfășurare ──────
    // Construiește starea live brută (scor + cartonașe/substituiri din
    // match_events până la minutul curent) și rulează predictLiveMarketsV2.
    // Silent-fail; NU atinge scoringul / predictAllMarkets / v1.
    try {
      const _elapsedLive = parseInt(elapsed) || 0;
      // elapsed>0 = singurul semnal live trimis de enrichUrl() din frontend
      // (status_short NU e trimis niciodată) → garda pe elapsed e suficientă.
      if (_elapsedLive > 0) {
        // Numără cartonașe (galben/roșu, al 2-lea galben = roșu) + substituiri
        // per echipă din match_events, până la elapsed curent.
        let hyc = 0, ayc = 0, hrc = 0, arc = 0, hsub = 0, asub = 0;
        if (fid) {
          try {
            const evq = await query(
              `SELECT team_id, type, detail FROM match_events
                 WHERE fixture_id = $1 AND elapsed IS NOT NULL AND elapsed <= $2`,
              [Number(fid), _elapsedLive]
            );
            for (const ev of (evq.rows || [])) {
              const isHome = Number(ev.team_id) === hId;
              const isAway = Number(ev.team_id) === aId;
              if (!isHome && !isAway) continue;
              const t = (ev.type || '').toLowerCase();
              const d = (ev.detail || '').toLowerCase();
              if (t === 'card') {
                if (d.includes('red') || d.includes('second yellow')) {
                  if (isHome) hrc++; else arc++;
                } else if (d.includes('yellow')) {
                  if (isHome) hyc++; else ayc++;
                }
              } else if (t === 'subst') {
                if (isHome) hsub++; else asub++;
              }
            }
          } catch (_) { /* fără evenimente live → contoare 0 */ }
        }
        const liveState = {
          elapsed: _elapsedLive,
          home_goals: parseInt(hg) || 0,
          away_goals: parseInt(ag) || 0,
          home_yc: hyc, away_yc: ayc, home_rc: hrc, away_rc: arc,
          home_subs: hsub, away_subs: asub,
        };
        payload.mlLive = predictLiveMarketsV2(liveState, payload, eloResult);
        payload.mlLiveAvailable = true;   // liveState valid (elapsed > 0, status live)
      }
    } catch (_) { /* ML live indisponibil → fără secțiune live */ }

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
        // [ML features] breakdown DEJA calculat (payload.breakdown) — doar persistat.
        const _bd = payload.breakdown || {};
        // league_group din league_stats.avg_goals_per_match (aceleași praguri ca recalibrate-tables).
        const _avgGoals = parseFloat(leagueStats?.avg_goals_per_match);
        const _leagueGroup = !Number.isFinite(_avgGoals) ? 'global'
          : _avgGoals < 2.3 ? 'low'
          : _avgGoals < 3.0 ? 'mid'
          : 'high';
        query(
          `INSERT INTO predictions (fixture_id, home_team, away_team, league_name, league_id, match_date,
            lambda_home, lambda_away, lambda_total, over15_prob, over25_prob, gg_prob,
            home_score_rate, away_score_rate, h2h_over15, confidence,
            api_home_pct, api_draw_pct, api_away_pct,
            score1, score2, score3, score4, score6, score7, h2h_sample, league_group,
            elo_adjusted, elo_diff_used)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
            $20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
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
            score1=EXCLUDED.score1, score2=EXCLUDED.score2, score3=EXCLUDED.score3,
            score4=EXCLUDED.score4, score6=EXCLUDED.score6, score7=EXCLUDED.score7,
            h2h_sample=EXCLUDED.h2h_sample, league_group=EXCLUDED.league_group,
            elo_adjusted=EXCLUDED.elo_adjusted, elo_diff_used=EXCLUDED.elo_diff_used,
            updated_at=NOW()
          WHERE predictions.result_over15 IS NULL`,
          [
            Number(fid), hn || '', an || '', lg || '', lgid ? Number(lgid) : null, dt || null,
            payload.lambdaHome, payload.lambdaAway, payload.lambdaTotal,
            payload.over15Prob, payload.over25Prob, payload.ggProb,
            payload.homeScoreRate, payload.awayScoreRate, payload.h2hOver15,
            payload.confidenceScore || null,
            apiHomePct, apiDrawPct, apiAwayPct,
            // [ML features] $20-$27 — breakdown persistat (score3/4/7 pot fi null = OK).
            _bd.poisson ?? null, _bd.forma ?? null, _bd.h2h ?? null,
            _bd.live ?? null, _bd.consistenta ?? null, _bd.putereEchipe ?? null,
            payload.h2hSample ?? null, _leagueGroup,
            payload.eloAdjusted === true, payload.eloDiffUsed ?? null,
          ]
        ).catch(() => {});
      }

    }

    // [C3] Salvează în cache (evicție FIFO la >200 intrări).
    if (enrichCache.size > 200) {
      [...enrichCache.keys()].slice(0, 100).forEach(k => enrichCache.delete(k));
    }
    enrichCache.set(cacheKey, { data: payload, ts: Date.now() });
    if (_isLiveReq) console.log(`[enrich] fid=${fid || '-'} MISS total=${Date.now() - _tEnrich}ms live=${!!_isLiveReq}`);

    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
