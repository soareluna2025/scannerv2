import { calcPoisson6x6, parseOddsItem, calcEV } from './calc-utils.js';
import { query } from './db.js';
import { fetchApiFootball } from './utils/fetch-api.js';

const matchCache = new Map();
const MATCH_CACHE_TTL        =      60_000; // 1 min — live matches
const MATCH_CACHE_TTL_STATIC = 10 * 60_000; // 10 min — NS / FT

// ── DB helpers — fallback chain pentru lambda Poisson ─────────────────────────
// Pattern identic cu enrich.js: form_stats → teams_stats → league_stats → 1.2
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

async function getTeamStatsFromDB(teamId, leagueId) {
  try {
    const r = leagueId
      ? await query(
          `SELECT avg_goals_for, avg_goals_against
           FROM teams_stats WHERE team_id = $1 AND league_id = $2
           ORDER BY season DESC LIMIT 1`,
          [teamId, Number(leagueId)]
        )
      : await query(
          `SELECT avg_goals_for, avg_goals_against
           FROM teams_stats WHERE team_id = $1
           ORDER BY season DESC LIMIT 1`,
          [teamId]
        );
    return r.rows[0] || null;
  } catch (_) { return null; }
}

async function getLeagueStats(lgid) {
  if (!lgid) return null;
  try {
    const r = await query('SELECT * FROM league_stats WHERE league_id = $1', [Number(lgid)]);
    return r.rows[0] || null;
  } catch (_) { return null; }
}

async function getLiveStatsFromDB(fixtureId) {
  if (!fixtureId) return null;
  try {
    const r = await query(
      `SELECT elapsed, home_sot, away_sot, home_goals, away_goals
       FROM live_stats
       WHERE fixture_id = $1
       ORDER BY recorded_at DESC
       LIMIT 1`,
      [Number(fixtureId)]
    );
    return r.rows[0] || null;
  } catch (_) { return null; }
}

// Dynamic lambda live — identic cu enrich.js calcDynamicLambda
function calcDynamicLambda(lambdaBase, elapsed, currentGoals, sot) {
  if (!elapsed || elapsed <= 0) return { lambda: lambdaBase, dynamic: false };
  const minutesLeft = Math.max(1, 90 - elapsed);
  const fraction = minutesLeft / 90;
  const shotRate = (sot / Math.max(elapsed, 1)) * 90;
  const intensityFactor = 1 + Math.min(shotRate / 25, 0.4);
  const lambdaRemaining = lambdaBase * fraction * intensityFactor;
  return { lambda: currentGoals + lambdaRemaining, dynamic: true };
}

function calcPoisson(hGames, aGames, h2h, hId, aId, lgHome = 1.2, lgAway = 1.2) {
  const avg = (arr, fn) => arr.length ? arr.reduce((s, m) => s + fn(m), 0) / arr.length : 0;
  const pct = (arr, fn) => arr.length >= 5 ? Math.round(arr.filter(fn).length / arr.length * 100) : null;
  const r2  = v => Math.round(v * 100) / 100;

  const homeAvgScored   = avg(hGames, m => ((m.teams?.home?.id === hId ? m.goals?.home : m.goals?.away) ?? 0));
  const homeAvgConceded = avg(hGames, m => ((m.teams?.home?.id === hId ? m.goals?.away : m.goals?.home) ?? 0));
  const awayAvgScored   = avg(aGames, m => ((m.teams?.away?.id === aId ? m.goals?.away : m.goals?.home) ?? 0));
  const awayAvgConceded = avg(aGames, m => ((m.teams?.away?.id === aId ? m.goals?.home : m.goals?.away) ?? 0));

  // Fallback la league avg cand form insuficient (<3 meciuri per echipa)
  const lambdaHome  = (hGames.length >= 3 && aGames.length >= 3)
    ? (homeAvgScored + awayAvgConceded) / 2
    : lgHome;
  const lambdaAway  = (hGames.length >= 3 && aGames.length >= 3)
    ? (awayAvgScored + homeAvgConceded) / 2
    : lgAway;
  const lambdaTotal = lambdaHome + lambdaAway;

  const matrix = calcPoisson6x6(lambdaHome, lambdaAway);

  const confidence = (h2h.length >= 8 && hGames.length >= 8 && aGames.length >= 8) ? 'HIGH'
                   : (h2h.length >= 5 && hGames.length >= 5 && aGames.length >= 5) ? 'MED' : 'LOW';

  const formResult = (m, isHome) => {
    const hg = m.goals?.home ?? 0, ag = m.goals?.away ?? 0;
    if (isHome) return hg > ag ? 'W' : hg === ag ? 'D' : 'L';
    return ag > hg ? 'W' : hg === ag ? 'D' : 'L';
  };
  const homeForm = hGames.slice(0, 5).map(m => ({
    result: formResult(m, m.teams?.home?.id === hId),
    score: `${m.goals?.home ?? 0}-${m.goals?.away ?? 0}`,
    // BUG #10 FIX: opponent corect — când hId a jucat în deplasare, adversarul e home
    opponent: (m.teams?.home?.id === hId ? m.teams?.away?.name : m.teams?.home?.name) || '?',
    date: m.fixture?.date?.slice(0, 10) || ''
  }));
  const awayForm = aGames.slice(0, 5).map(m => ({
    result: formResult(m, m.teams?.home?.id === aId),
    score: `${m.goals?.home ?? 0}-${m.goals?.away ?? 0}`,
    // BUG #10 FIX: opponent corect — când aId a jucat acasă, adversarul e away
    opponent: (m.teams?.away?.id === aId ? m.teams?.home?.name : m.teams?.away?.name) || '?',
    date: m.fixture?.date?.slice(0, 10) || ''
  }));
  const h2hForm = h2h.slice(0, 5).map(m => ({
    home: m.teams?.home?.name || '?',
    away: m.teams?.away?.name || '?',
    score: `${m.goals?.home ?? 0}-${m.goals?.away ?? 0}`,
    date: m.fixture?.date?.slice(0, 10) || ''
  }));

  return {
    homeAvgScored: r2(homeAvgScored), homeAvgConceded: r2(homeAvgConceded),
    homeScoreRate: pct(hGames, m => ((m.teams?.home?.id === hId ? m.goals?.home : m.goals?.away) ?? 0) > 0),
    awayAvgScored: r2(awayAvgScored), awayAvgConceded: r2(awayAvgConceded),
    awayScoreRate: pct(aGames, m => ((m.teams?.away?.id === aId ? m.goals?.away : m.goals?.home) ?? 0) > 0),
    lambdaHome: r2(lambdaHome), lambdaAway: r2(lambdaAway), lambdaTotal: r2(lambdaTotal),
    over15Prob: matrix.over15Prob, over25Prob: matrix.over25Prob, ggProb: matrix.ggProb,
    homeWin: matrix.homeWin, draw: matrix.draw, awayWin: matrix.awayWin,
    // BUG #11 FIX: fallback la matrix.over15Prob/ggProb când pct() returnează null (sample <5)
    h2hOver15: pct(h2h, m => ((m.goals?.home ?? 0) + (m.goals?.away ?? 0)) > 1) ?? matrix.over15Prob,
    h2hGG:     pct(h2h, m => (m.goals?.home ?? 0) > 0 && (m.goals?.away ?? 0) > 0) ?? matrix.ggProb,
    h2hSample: h2h.length, confidence,
    homeForm, awayForm, h2hForm
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  const { id, h, a, br } = req.query;
  if (!id) return res.status(400).json({ error: 'Parametrul id este necesar' });
  if (!h || !a) return res.status(400).json({ error: 'Parametrii h si a sunt necesari' });

  const hId      = Number(h);
  const aId      = Number(a);

  // ── Cache check ───────────────────────────────────────────────
  const cachedEntry = matchCache.get(id);
  if (cachedEntry) {
    const status = cachedEntry.data?.fixture?.fixture?.status?.short || 'NS';
    const isLive = ['1H', '2H', 'ET', 'BT', 'P', 'LIVE'].includes(status);
    const ttl    = isLive ? MATCH_CACHE_TTL : MATCH_CACHE_TTL_STATIC;
    if (Date.now() - cachedEntry.ts < ttl) {
      return res.status(200).json(cachedEntry.data);
    }
    matchCache.delete(id);
  }

  // Cache eviction
  if (matchCache.size > 100) {
    [...matchCache.keys()].slice(0, 50).forEach(k => matchCache.delete(k));
  }

  try {
    // ── DB fallback: form_stats → teams_stats, plus h2h/odds/logos/live ─
    const [dbH2H, sbHForm, sbAForm, dbOddsRows, dbLogos, tsH, tsA, liveStats] = await Promise.all([
      query('SELECT home_team_id, away_team_id, home_goals, away_goals, match_date FROM h2h WHERE (home_team_id=$1 AND away_team_id=$2) OR (home_team_id=$2 AND away_team_id=$1) ORDER BY match_date DESC LIMIT 10', [hId, aId]).catch(() => ({ rows: [] })),
      getFormFromDB(hId),
      getFormFromDB(aId),
      query('SELECT *, bet_name AS market, value_name AS label, value_odd AS odd_value FROM odds WHERE fixture_id=$1 AND bookmaker_id=8', [Number(id)]).catch(() => ({ rows: [] })),
      query('SELECT team_id, logo FROM teams WHERE team_id = ANY($1)', [[hId, aId]]).catch(() => ({ rows: [] })),
      getTeamStatsFromDB(hId, null),
      getTeamStatsFromDB(aId, null),
      getLiveStatsFromDB(id),
    ]);

    const needH2H   = dbH2H.rows.length   < 3;
    const needHForm = sbHForm.length      < 3;
    const needAForm = sbAForm.length      < 3;
    const needOdds  = dbOddsRows.rows.length === 0;

    // ── Always fetch fixture details, lineups, players, events ─
    const [rFix, rLineups, rPlayers, rEvents, rHForm, rAForm, rH2H, rOdds] = await Promise.all([
      fetchApiFootball(`/fixtures?id=${id}`),
      fetchApiFootball(`/fixtures/lineups?fixture=${id}`),
      fetchApiFootball(`/fixtures/players?fixture=${id}`),
      fetchApiFootball(`/fixtures/events?fixture=${id}`),
      needHForm ? fetchApiFootball(`/fixtures?team=${h}&last=20&status=FT`) : null,
      needAForm ? fetchApiFootball(`/fixtures?team=${a}&last=20&status=FT`) : null,
      needH2H   ? fetchApiFootball(`/fixtures/headtohead?h2h=${h}-${a}&last=10`) : null,
      needOdds  ? fetchApiFootball(`/odds?fixture=${id}&bookmaker=8`) : null,
    ]);

    const [dFix, dLineups, dPlayers, dEvents] = await Promise.all([
      rFix.json(), rLineups.json(), rPlayers.json(), rEvents.json(),
    ]);
    const dHForm = needHForm ? await rHForm.json() : null;
    const dAForm = needAForm ? await rAForm.json() : null;
    const dH2H   = needH2H  ? await rH2H.json()   : null;
    const dOdds  = needOdds  ? await rOdds.json()  : null;

    const logoMap = Object.fromEntries((dbLogos.rows || []).map(r => [Number(r.team_id), r.logo]));

    const fixture = (dFix.response || [])[0] || null;

    // Inject DB logos where API logo is missing
    if (fixture?.teams?.home) fixture.teams.home.logo = fixture.teams.home.logo || logoMap[hId] || null;
    if (fixture?.teams?.away) fixture.teams.away.logo = fixture.teams.away.logo || logoMap[aId] || null;
    const lineups = dLineups.response || [];
    const players = dPlayers.response || [];
    const events  = dEvents.response  || [];

    // Resolve h2h
    const h2hFromDB = dbH2H.rows.map(r => ({
      teams: { home: { id: r.home_team_id }, away: { id: r.away_team_id } },
      goals: { home: r.home_goals ?? 0, away: r.away_goals ?? 0 },
      fixture: { date: r.match_date },
    }));
    const h2h = needH2H
      ? (dH2H?.response || []).slice(0, 10)
      : h2hFromDB;

    // Resolve form: form_stats DB (sbXForm) → API fallback (dXForm)
    const hGames = needHForm
      ? (dHForm?.response || []).slice(0, 10)
      : sbHForm;
    const aGames = needAForm
      ? (dAForm?.response || []).slice(0, 10)
      : sbAForm;

    // Resolve odds
    let oddsRaw = null;
    if (!needOdds && dbOddsRows.rows.length > 0) {
      const betsMap = {};
      for (const r of dbOddsRows.rows) {
        if (!betsMap[r.market]) betsMap[r.market] = [];
        betsMap[r.market].push({ value: r.label, odd: String(r.odd_value) });
      }
      oddsRaw = parseOddsItem({
        bookmakers: [{ id: 8, name: 'Bet365', bets: Object.entries(betsMap).map(([name, values]) => ({ name, values })) }],
      });
    } else if (needOdds && dOdds) {
      const oddsItem = (dOdds.response || [])[0];
      if (oddsItem) oddsRaw = parseOddsItem(oddsItem);
    }
    if (!oddsRaw && fixture?.league?.id) {
      try {
        const r2 = await fetchApiFootball(`/odds?league=${fixture.league.id}&season=${new Date().getFullYear()}&bookmaker=8`);
        const d2 = await r2.json();
        const item2 = (d2.response || []).find(x => x.fixture?.id === Number(id));
        if (item2) oddsRaw = parseOddsItem(item2);
      } catch (_) {}
    }

    // ── League stats fallback (priority 3) — necesita lgid din fixture ─
    const lgid = fixture?.league?.id || null;
    const leagueStats = lgid ? await getLeagueStats(lgid) : null;
    const lgHome = parseFloat(leagueStats?.avg_home_goals) || 1.2;
    const lgAway = parseFloat(leagueStats?.avg_away_goals) || 1.2;

    const poissonResult = calcPoisson(hGames, aGames, h2h, hId, aId, lgHome, lgAway);

    // ── teams_stats lambda override — priority 2 (intre form si league_stats) ─
    // Aplicat doar cand form-ul ramane insuficient dupa form_stats DB + API
    const formInsufficient = hGames.length < 3 || aGames.length < 3;
    if (formInsufficient && (tsH || tsA)) {
      const r2 = v => Math.round(v * 100) / 100;
      const tsHScored   = tsH ? +(tsH.avg_goals_for)     : null;
      const tsHConceded = tsH ? +(tsH.avg_goals_against) : null;
      const tsAScored   = tsA ? +(tsA.avg_goals_for)     : null;
      const tsAConceded = tsA ? +(tsA.avg_goals_against) : null;
      if (tsHScored != null && tsAConceded != null)
        poissonResult.lambdaHome = r2((tsHScored + tsAConceded) / 2);
      if (tsAScored != null && tsHConceded != null)
        poissonResult.lambdaAway = r2((tsAScored + tsHConceded) / 2);
      poissonResult.lambdaTotal = r2(poissonResult.lambdaHome + poissonResult.lambdaAway);
      // Recalculate matrix with improved lambdas
      const mx2 = calcPoisson6x6(poissonResult.lambdaHome, poissonResult.lambdaAway);
      Object.assign(poissonResult, {
        over15Prob: mx2.over15Prob, over25Prob: mx2.over25Prob,
        ggProb: mx2.ggProb, homeWin: mx2.homeWin,
        draw: mx2.draw, awayWin: mx2.awayWin,
      });
    }

    // ── Dynamic lambda live — override final cand live_stats are date ─────────
    // Source: tabel live_stats (snapshot scanner cron); recordat per minut.
    if (liveStats && Number(liveStats.elapsed) > 0) {
      const r2 = v => Math.round(v * 100) / 100;
      const elapsed = Number(liveStats.elapsed);
      const hgCur   = Number(liveStats.home_goals) || 0;
      const agCur   = Number(liveStats.away_goals) || 0;
      const hSot    = Number(liveStats.home_sot)   || 0;
      const aSot    = Number(liveStats.away_sot)   || 0;
      const dynHome = calcDynamicLambda(poissonResult.lambdaHome, elapsed, hgCur, hSot);
      const dynAway = calcDynamicLambda(poissonResult.lambdaAway, elapsed, agCur, aSot);
      poissonResult.lambdaHome  = r2(dynHome.lambda);
      poissonResult.lambdaAway  = r2(dynAway.lambda);
      poissonResult.lambdaTotal = r2(poissonResult.lambdaHome + poissonResult.lambdaAway);
      // Recalculate matrix with dynamic lambdas
      const mx3 = calcPoisson6x6(poissonResult.lambdaHome, poissonResult.lambdaAway);
      Object.assign(poissonResult, {
        over15Prob: mx3.over15Prob, over25Prob: mx3.over25Prob,
        ggProb: mx3.ggProb, homeWin: mx3.homeWin,
        draw: mx3.draw, awayWin: mx3.awayWin,
      });
      poissonResult.isDynamic = true;
      poissonResult.liveElapsed = elapsed;
      poissonResult.liveScore = `${hgCur}-${agCur}`;
    }

    const evData        = calcEV(poissonResult, oddsRaw);
    const enrich        = { ...poissonResult, ...evData };

    // Fire-and-forget prediction save
    if (fixture) {
      query(
        `INSERT INTO predictions (fixture_id, home_team, away_team, league_name, league_id, match_date,
          lambda_home, lambda_away, lambda_total, over15_prob, over25_prob, gg_prob,
          home_score_rate, away_score_rate, h2h_over15)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (fixture_id) DO UPDATE SET
          lambda_home = EXCLUDED.lambda_home, lambda_away = EXCLUDED.lambda_away,
          lambda_total = EXCLUDED.lambda_total, over15_prob = EXCLUDED.over15_prob,
          over25_prob = EXCLUDED.over25_prob, gg_prob = EXCLUDED.gg_prob,
          home_score_rate = EXCLUDED.home_score_rate, away_score_rate = EXCLUDED.away_score_rate,
          h2h_over15 = EXCLUDED.h2h_over15`,
        [
          fixture.fixture?.id,
          fixture.teams?.home?.name || '',
          fixture.teams?.away?.name || '',
          fixture.league?.name      || '',
          fixture.league?.id        || null,
          fixture.fixture?.date     || null,
          enrich.lambdaHome, enrich.lambdaAway, enrich.lambdaTotal,
          enrich.over15Prob, enrich.over25Prob, enrich.ggProb,
          enrich.homeScoreRate, enrich.awayScoreRate, enrich.h2hOver15,
        ]
      ).catch(() => {});
    }

    const flatPlayers = players.flatMap(team =>
      (team.players || []).map(p => ({
        id:          p.player?.id,
        name:        p.player?.name,
        teamId:      team.team?.id,
        teamName:    team.team?.name,
        photo:       p.player?.photo,
        rating:      parseFloat(p.statistics?.[0]?.games?.rating) || null,
        minutes:     p.statistics?.[0]?.games?.minutes || 0,
        goals:       p.statistics?.[0]?.goals?.total   || 0,
        assists:     p.statistics?.[0]?.goals?.assists  || 0,
        passAcc:     p.statistics?.[0]?.passes?.accuracy || null,
        dribbles:    p.statistics?.[0]?.dribbles?.success || 0,
        yellowCards: p.statistics?.[0]?.cards?.yellow   || 0,
        redCards:    p.statistics?.[0]?.cards?.red      || 0,
        position:    p.statistics?.[0]?.games?.position || ''
      }))
    ).sort((a, b) => (b.rating || 0) - (a.rating || 0));

    const responseData = { fixture, lineups, players: flatPlayers, events, enrich };
    matchCache.set(id, { data: responseData, ts: Date.now() });
    res.status(200).json(responseData);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
