import { runSimulation } from './monte-carlo.js';
import { calcMomentum }  from './match-momentum.js';
import { calcElo }       from './elo.js';

const cache = new Map();
const CACHE_TTL = 120000; // 2 minutes

function statVal(arr, name) {
  const s = arr?.find(x => x.type === name);
  const v = s?.value;
  if (v == null) return 0;
  if (typeof v === 'string' && v.endsWith('%')) return parseFloat(v);
  return parseFloat(v) || 0;
}

async function apiFetch(path, key) {
  const r = await fetch(`https://v3.football.api-sports.io${path}`,
    { headers: { 'x-apisports-key': key } });
  const d = await r.json();
  return d.response || [];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key   = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  const q = req.method === 'POST' ? (req.body || {}) : req.query;
  const fid = Number(q.fixture_id);
  const hid = Number(q.home_id);
  const aid = Number(q.away_id);
  const lid = Number(q.league_id) || 0;

  if (!fid || !hid || !aid)
    return res.status(400).json({ error: 'fixture_id, home_id, away_id required' });

  const ck = String(fid);
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return res.status(200).json(hit.data);

  // ── Parallel data collection ──────────────────────────────────
  const dq = {};

  async function af(path, label) {
    try {
      const r = await apiFetch(path, key);
      dq[label] = r.length ? '✅' : '⚠️';
      return r;
    } catch { dq[label] = '❌'; return []; }
  }

  async function sf(query, label) {
    if (!sbUrl || !sbKey) { dq[label] = '❌'; return []; }
    try {
      const r = await fetch(`${sbUrl}/rest/v1/player_stats?${query}&limit=100`,
        { headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` } });
      const d = await r.json();
      dq[label] = Array.isArray(d) && d.length ? '✅' : '⚠️';
      return Array.isArray(d) ? d : [];
    } catch { dq[label] = '❌'; return []; }
  }

  const season = new Date().getFullYear();
  const [fixRes, homeFx, awayFx, h2hFx, lineupsRes,
         homePlayers, awayPlayers, standingsRes, oddsRes] = await Promise.all([
    af(`/fixtures?id=${fid}`,                                  'fixture'),
    af(`/fixtures?team=${hid}&last=10&status=FT`,              'homeForm'),
    af(`/fixtures?team=${aid}&last=10&status=FT`,              'awayForm'),
    af(`/fixtures/headtohead?h2h=${hid}-${aid}&last=10`,       'h2h'),
    af(`/fixtures/lineups?fixture=${fid}`,                     'lineups'),
    sf(`team_id=eq.${hid}&order=fixture_id.desc`,              'homePlayers'),
    sf(`team_id=eq.${aid}&order=fixture_id.desc`,              'awayPlayers'),
    lid ? af(`/standings?league=${lid}&season=${season}`,      'standings') : Promise.resolve([]),
    af(`/odds?fixture=${fid}`,                                    'odds'),
  ]);

  // ── Fixture basics ────────────────────────────────────────────
  const fix      = fixRes[0] || null;
  const fixStatus = fix?.fixture?.status?.short || 'NS';
  const isLive   = ['1H','2H','HT','ET','BT','P','LIVE','INT'].includes(fixStatus);
  const elapsed  = fix?.fixture?.status?.elapsed || 0;
  const hgCur    = fix?.goals?.home ?? 0;
  const agCur    = fix?.goals?.away ?? 0;
  const homeName = fix?.teams?.home?.name || 'Gazde';
  const awayName = fix?.teams?.away?.name || 'Oaspeți';

  // ── Live stats ────────────────────────────────────────────────
  const hSt = fix?.statistics?.[0]?.statistics || [];
  const aSt = fix?.statistics?.[1]?.statistics || [];
  const homePoss      = statVal(hSt, 'Ball Possession') || 50;
  const homeSoT       = statVal(hSt, 'Shots on Goal');
  const awaySoT       = statVal(aSt, 'Shots on Goal');
  const homeDngAtt    = statVal(hSt, 'Dangerous Attacks');
  const awayDngAtt    = statVal(aSt, 'Dangerous Attacks');
  const homeCorners   = statVal(hSt, 'Corner Kicks');
  const awayCorners   = statVal(aSt, 'Corner Kicks');
  const homexGLive    = statVal(hSt, 'expected_goals') || statVal(hSt, 'xG');
  const awayxGLive    = statVal(aSt, 'expected_goals') || statVal(aSt, 'xG');

  const liveStats = isLive ? {
    minute: elapsed, homeGoals: hgCur, awayGoals: agCur,
    homexG: homexGLive, awayxG: awayxGLive,
    homePossession: homePoss, homeShotsOnTarget: homeSoT, awayShotsOnTarget: awaySoT,
    homeDangerousAttacks: homeDngAtt, awayDangerousAttacks: awayDngAtt,
    homeCorners, awayCorners,
  } : null;

  // ── Form calculation ──────────────────────────────────────────
  function calcForm(matches, teamId) {
    if (!matches.length) return null;
    let gS = 0, gC = 0, xgF = 0, xgA = 0, sot = 0, poss = 0, wins = 0, cs = 0;
    const form5 = [];
    const sorted = [...matches].sort((a, b) => new Date(b.fixture?.date) - new Date(a.fixture?.date));
    for (const m of sorted) {
      const ih = m.teams?.home?.id === teamId;
      const gs = ih ? (m.goals?.home ?? 0) : (m.goals?.away ?? 0);
      const gc = ih ? (m.goals?.away ?? 0) : (m.goals?.home ?? 0);
      gS += gs; gC += gc;
      if (gc === 0) cs++;
      if (gs > gc) wins++;
      if (form5.length < 5) form5.push(gs > gc ? 'W' : gs === gc ? 'D' : 'L');
      const tSt = (ih ? m.statistics?.[0] : m.statistics?.[1])?.statistics || [];
      const oSt = (ih ? m.statistics?.[1] : m.statistics?.[0])?.statistics || [];
      xgF  += statVal(tSt, 'expected_goals') || gs;
      xgA  += statVal(oSt, 'expected_goals') || gc;
      sot  += statVal(tSt, 'Shots on Goal');
      poss += statVal(tSt, 'Ball Possession') || 50;
    }
    const n = matches.length;
    return {
      goalsScored:   +(gS / n).toFixed(2),
      goalsConceded: +(gC / n).toFixed(2),
      xGFor:         +(xgF / n).toFixed(2),
      xGAgainst:     +(xgA / n).toFixed(2),
      shotsOnTarget: +(sot  / n).toFixed(2),
      possession:    Math.round(poss / n),
      winRate:       Math.round(wins / n * 100),
      cleanSheets:   Math.round(cs   / n * 100),
      form5,
    };
  }

  const homeForm = calcForm(homeFx, hid);
  const awayForm = calcForm(awayFx, aid);

  // ── Squad strength from Supabase ──────────────────────────────
  function calcSquad(players) {
    if (!players.length) return null;
    const ratings = players.map(p => p.rating).filter(r => r != null);
    const avgRating  = ratings.length ? ratings.reduce((s, r) => s + r, 0) / ratings.length : 7.0;
    const avgPassAcc = players.reduce((s, p) => s + (p.pass_accuracy || 0), 0) / players.length;
    const avgSOT     = players.reduce((s, p) => s + (p.shots_on_target || 0), 0) / players.length;
    const topScorer  = players.reduce((b, p) => (p.goals || 0) > (b.goals || 0) ? p : b, {});
    const key3       = [...players].sort((a, b) => (b.player_score || 0) - (a.player_score || 0)).slice(0, 3);
    const strength   = Math.round(
      (avgRating / 10 * 100) * 0.35 +
      Math.min(100, avgSOT * 12) * 0.25 +
      avgPassAcc * 0.20 +
      Math.min(100, (topScorer.goals || 0) * 20) * 0.20
    );
    return {
      avgRating:    +avgRating.toFixed(2),
      avgPassAccuracy: +avgPassAcc.toFixed(1),
      avgShotsOnTarget: +avgSOT.toFixed(1),
      topScorer:    { name: topScorer.player_name || '—', goals: topScorer.goals || 0 },
      keyPlayers:   key3.map(p => ({ name: p.player_name, score: p.player_score })),
      strength,
      playerCount:  players.length,
    };
  }

  const homeSquad = calcSquad(homePlayers);
  const awaySquad = calcSquad(awayPlayers);

  // ── Standings / league avg ────────────────────────────────────
  const leagueTable = standingsRes[0]?.league?.standings?.[0] || [];
  const homeStd = leagueTable.find(s => s.team?.id === hid) || null;
  const awayStd = leagueTable.find(s => s.team?.id === aid) || null;
  let leagueAvgGoals = 2.5;
  if (leagueTable.length) {
    const tGF  = leagueTable.reduce((s, t) => s + (t.all?.goals?.for  || 0), 0);
    const tPld = leagueTable.reduce((s, t) => s + (t.all?.played       || 0), 0);
    if (tPld) leagueAvgGoals = +(tGF / tPld).toFixed(2);
  }

  // ── Elo ───────────────────────────────────────────────────────
  const elo = calcElo(homeFx, awayFx, hid, aid, h2hFx);

  // ── Lambda ───────────────────────────────────────────────────
  const lgH = leagueAvgGoals / 2; // per-team average
  const hAvgS  = homeForm?.goalsScored   || lgH;
  const hAvgC  = homeForm?.goalsConceded || lgH;
  const aAvgS  = awayForm?.goalsScored   || lgH;
  const aAvgC  = awayForm?.goalsConceded || lgH;

  const hAtt = hAvgS / lgH;
  const hDef = hAvgC / lgH;
  const aAtt = aAvgS / lgH;
  const aDef = aAvgC / lgH;

  const eloFactor  = 1 + (elo.eloDiff / 4000);
  const pfHome = homeSquad ? homeSquad.avgRating / 7.0 : 1.0;
  const pfAway = awaySquad ? awaySquad.avgRating / 7.0 : 1.0;

  let lH = Math.max(0.3, Math.min(4.0, hAtt * aDef * lgH * eloFactor  * pfHome * 1.15));
  let lA = Math.max(0.3, Math.min(4.0, aAtt * hDef * lgH / eloFactor  * pfAway));

  if (isLive && elapsed > 0) {
    const mRem = Math.max(1, 90 - elapsed);
    lH = Math.max(0.05, lH * (mRem / 90) + homexGLive * 0.3);
    lA = Math.max(0.05, lA * (mRem / 90) + awayxGLive * 0.3);
  }

  // ── Monte Carlo ───────────────────────────────────────────────
  // Pass current score so live simulations show correct final scores
  const sim = runSimulation(lH, lA, 10000, isLive ? hgCur : 0, isLive ? agCur : 0);

  // ── Momentum ─────────────────────────────────────────────────
  const momentum = liveStats ? calcMomentum(liveStats) : null;

  // ── Data quality ─────────────────────────────────────────────
  const missing = Object.values(dq).filter(v => v === '❌').length;
  const dqLevel = missing === 0 ? 'HIGH' : missing <= 2 ? 'MED' : 'LOW';

  // ── Odds & recommendation ─────────────────────────────────────
  // Prefer Bet365 (6), then Bwin (2), William Hill (3), else first available
  const allBookmakers = oddsRes[0]?.bookmakers || [];
  const preferredIds = [6, 2, 3, 8, 1];
  const bookmaker = preferredIds.map(id => allBookmakers.find(b => b.id === id)).find(Boolean)
    || allBookmakers[0];
  const bets = bookmaker?.bets || [];
  function odd(betName, val) {
    const bet = bets.find(b => b.name === betName);
    const ov  = bet?.values?.find(v => v.value === val);
    return ov ? parseFloat(ov.odd) : null;
  }

  const candidates = [
    { name: 'Over 1.5', prob: sim.markets.over15, cota: odd('Goals Over/Under', 'Over 1.5') },
    { name: 'Over 2.5', prob: sim.markets.over25, cota: odd('Goals Over/Under', 'Over 2.5') },
    { name: 'GG',       prob: sim.markets.gg,     cota: odd('Both Teams Score', 'Yes') },
    { name: '1 Gazde',  prob: sim.results.homeWin, cota: odd('Match Winner', 'Home') },
    { name: 'X Egal',   prob: sim.results.draw,    cota: odd('Match Winner', 'Draw') },
    { name: '2 Oaspeți',prob: sim.results.awayWin, cota: odd('Match Winner', 'Away') },
  ];
  let bestBet = null, bestEV = -Infinity;
  for (const c of candidates) {
    if (!c.cota || c.prob < 10) continue;
    const ev = (c.prob / 100) - (1 / c.cota);
    if (ev > bestEV) { bestEV = ev; bestBet = { ...c, ev }; }
  }

  // ── Response ──────────────────────────────────────────────────
  const result = {
    fixture: {
      id: fid, homeTeam: homeName, awayTeam: awayName,
      league: fix?.league?.name || '',
      minute: elapsed, score: `${hgCur}-${agCur}`, status: fixStatus,
    },
    realData: {
      homeForm: homeForm ? { goalsScored: homeForm.goalsScored, xGFor: homeForm.xGFor, winRate: homeForm.winRate, form5: homeForm.form5, cleanSheets: homeForm.cleanSheets } : null,
      awayForm: awayForm ? { goalsScored: awayForm.goalsScored, xGFor: awayForm.xGFor, winRate: awayForm.winRate, form5: awayForm.form5, cleanSheets: awayForm.cleanSheets } : null,
      homeElo: elo.homeElo, awayElo: elo.awayElo, eloDiff: elo.eloDiff,
      homeSquadStrength: homeSquad?.strength ?? null,
      awaySquadStrength: awaySquad?.strength ?? null,
      homeTopScorer: homeSquad?.topScorer || null,
      awayTopScorer: awaySquad?.topScorer || null,
      homeStanding: homeStd ? { position: homeStd.rank, points: homeStd.points } : null,
      awayStanding: awayStd ? { position: awayStd.rank, points: awayStd.points } : null,
      leagueAvgGoals,
      dataQuality: dqLevel,
      dataSources: dq,
    },
    simulation: {
      lambdaHome: +lH.toFixed(2),
      lambdaAway: +lA.toFixed(2),
      simCount: 10000,
      results:           sim.results,
      markets:           sim.markets,
      scoreDistribution: sim.scoreDistribution,
      mostLikelyScore:   sim.mostLikelyScore,
      secondMostLikelyScore: sim.secondMostLikelyScore,
      expectedScore:     isLive
        ? `${+(hgCur + lH).toFixed(2)} - ${+(agCur + lA).toFixed(2)}`
        : `${+lH.toFixed(2)} - ${+lA.toFixed(2)}`,
      goalTiming:        sim.goalTiming,
      confidence:        sim.confidence,
    },
    momentum,
    recommendation: bestBet ? {
      bestBet:    bestBet.name,
      confidence: Math.round(bestBet.prob),
      ev:         `${bestEV >= 0 ? '+' : ''}${(bestEV * 100).toFixed(1)}%`,
      cota:       bestBet.cota,
      reasoning:  `λ total ${+(lH + lA).toFixed(2)}, Elo diff ${elo.eloDiff > 0 ? '+' : ''}${elo.eloDiff}, ${dqLevel} data quality`,
    } : null,
  };

  cache.set(ck, { data: result, ts: Date.now() });
  return res.status(200).json(result);
}
