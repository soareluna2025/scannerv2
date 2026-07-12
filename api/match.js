import { calcPoisson6x6, parseOddsItem, calcEV } from './calc-utils.js';
import { predictAllMarkets } from './ml-predict.js';
import { query } from './db.js';
import { fetchApiFootball } from './utils/fetch-api.js';

const matchCache = new Map();
const MATCH_CACHE_TTL        =      60_000; // 1 min — live matches
const MATCH_CACHE_TTL_STATIC = 10 * 60_000; // 10 min — NS / FT

// Feature flag — afișare cote 1X2 pre-meci (citite din prematch_data). DOAR afișare.
const SHOW_MARKET_ODDS = false;

// Extrage cotele 1X2 (Match Winner: Home/Draw/Away) dintr-un payload /odds
// API-Football salvat în prematch_data (array de response-uri). Preferă Bet365
// (bookmaker id=8); altfel prima casă disponibilă. Returnează {home,draw,away,bookmaker}
// sau null dacă nu găsește. PUR citire — niciun calcul de scoring.
function extractMatchWinnerOdds(payload) {
  try {
    const arr = Array.isArray(payload) ? payload : (payload ? [payload] : []);
    let bookmakers = [];
    for (const entry of arr) {
      if (Array.isArray(entry?.bookmakers)) bookmakers = bookmakers.concat(entry.bookmakers);
    }
    if (!bookmakers.length) return null;
    const bk = bookmakers.find(b => Number(b?.id) === 8) || bookmakers[0];
    const bet = (bk?.bets || []).find(b => b?.name === 'Match Winner');
    if (!bet || !Array.isArray(bet.values)) return null;
    const pick = name => {
      const v = bet.values.find(x => String(x?.value).toLowerCase() === name);
      const n = v ? parseFloat(v.odd) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const home = pick('home'), draw = pick('draw'), away = pick('away');
    if (home == null && draw == null && away == null) return null;
    return { home, draw, away, bookmaker: bk?.name || null };
  } catch (_) { return null; }
}


// ── fmtDate — normalizează data la "YYYY-MM-DD" indiferent de tip ─────────────
// API-Football trimite string ISO ("2026-05-30T20:00:00+00:00"), dar fallback-ul
// din DB (h2hFromDB cu r.match_date) întoarce un obiect Date din node-postgres,
// pe care `.slice()` îl făcea să crape ("m.fixture?.date?.slice is not a function").
// Acoperă: Date object, timestamp Unix (sec/ms), string ISO, null/undefined.
function fmtDate(val) {
  if (!val) return '';
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (typeof val === 'number') {
    const ms = val < 1e12 ? val * 1000 : val; // sec → ms dacă pare timestamp în secunde
    const d = new Date(ms);
    return isNaN(d) ? '' : d.toISOString().slice(0, 10);
  }
  return String(val).slice(0, 10);
}

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

// ── getPlayerStatsFromDB — citește statistici jucători din player_stats ────────
// Populată de cron collect-finished (nightly) pentru meciuri FT/AET/PEN.
// Returnează direct forma flatPlayers (aceleași chei ca maparea din API) ca să
// poată fi servită ca atare → economie 1 call /fixtures/players per modal FT.
// Întoarce [] dacă nu există rânduri (meci live/viitor sau încă necolectat).
async function getPlayerStatsFromDB(fixtureId) {
  try {
    const r = await query(
      `SELECT player_id, team_id, team_name, player_name, position, rating,
              goals, assists, pass_accuracy, dribbles_success,
              shots_total, shots_on_target, minutes_played,
              yellow_cards, red_cards
         FROM player_stats
        WHERE fixture_id = $1`,
      [Number(fixtureId)]
    );
    return r.rows.map(row => ({
      id:              row.player_id,
      name:            row.player_name,
      teamId:          row.team_id,
      teamName:        row.team_name,
      photo:           null,
      rating:          row.rating != null ? Number(row.rating) : null,
      minutes:         row.minutes_played || 0,
      goals:           row.goals || 0,
      assists:         row.assists || 0,
      passAcc:         row.pass_accuracy != null ? Number(row.pass_accuracy) : null,
      dribbles:        row.dribbles_success || 0,
      yellowCards:     row.yellow_cards || 0,
      redCards:        row.red_cards || 0,
      position:        row.position || '',
      // shots_total = 0 pe rândurile vechi (collect-finished nu îl colecta înainte
      // de acest commit) → tratăm 0 ca „indisponibil" ⇒ frontend afișează „-",
      // evitând „0/2" inconsistent. Rândurile noi (re-colectate) au valoarea reală.
      shots_total:     row.shots_total ? Number(row.shots_total) : null,
      shots_on_target: row.shots_on_target != null ? Number(row.shots_on_target) : null,
    })).sort((a, b) => (b.rating || 0) - (a.rating || 0));
  } catch (_) { return []; }
}

// Predicție pre-calculată (collect-daily) — λ + probabilități Poisson din DB.
// Folosită pentru a afișa instant date pre-meci, fără recalcul/fetch on-demand.
async function getPredictionFromDB(fixtureId) {
  try {
    const r = await query(
      `SELECT lambda_home, lambda_away FROM predictions WHERE fixture_id = $1`,
      [Number(fixtureId)]
    );
    return r.rows[0] || null;
  } catch (_) { return null; }
}

// Fallback ARBITRU când /fixtures?id live nu-l are încă (frecvent la NS ~1h):
// fixtures.referee (persistat de prematch-enrichment stage 6/7) → prematch_data
// 'referee_late' → prematch_data 'fixture'. Returnează numele sau null.
async function getRefereeFromDB(fixtureId) {
  try {
    const r = await query(`SELECT referee FROM fixtures WHERE fixture_id = $1`, [Number(fixtureId)]);
    const col = r.rows[0]?.referee;
    if (col && String(col).trim() && col !== 'null') return String(col).trim();
    const p = await query(
      `SELECT data_type, payload FROM prematch_data
        WHERE fixture_id = $1 AND data_type IN ('referee_late','fixture')
        ORDER BY data_type DESC`,
      [Number(fixtureId)]
    );
    for (const row of p.rows) {
      const arr = row.payload;
      const rr = Array.isArray(arr) ? (arr[0]?.fixture?.referee ?? arr[0]?.referee) : null;
      if (rr && String(rr).trim() && rr !== 'null') return String(rr).trim();
    }
    return null;
  } catch (_) { return null; }
}

// Fallback ANTRENORI din prematch_data (coach_home/coach_away, stage 1) — folosit
// în tab FORMAȚII când lineup-urile API încă nu sunt anunțate (~1h înainte).
async function getCoachesFromDB(fixtureId) {
  try {
    const r = await query(
      `SELECT data_type, payload FROM prematch_data
        WHERE fixture_id = $1 AND data_type IN ('coach_home','coach_away')`,
      [Number(fixtureId)]
    );
    const out = {};
    for (const row of r.rows) {
      const arr = row.payload;
      const c = Array.isArray(arr) ? arr[0] : null;
      if (c && c.name) {
        const side = row.data_type === 'coach_home' ? 'home' : 'away';
        out[side] = { name: c.name, photo: c.photo || null };
      }
    }
    return out;
  } catch (_) { return {}; }
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
    date: fmtDate(m.fixture?.date)
  }));
  const awayForm = aGames.slice(0, 5).map(m => ({
    result: formResult(m, m.teams?.home?.id === aId),
    score: `${m.goals?.home ?? 0}-${m.goals?.away ?? 0}`,
    // BUG #10 FIX: opponent corect — când aId a jucat acasă, adversarul e away
    opponent: (m.teams?.away?.id === aId ? m.teams?.home?.name : m.teams?.away?.name) || '?',
    date: fmtDate(m.fixture?.date)
  }));
  const h2hForm = h2h.slice(0, 5).map(m => ({
    home: m.teams?.home?.name || '?',
    away: m.teams?.away?.name || '?',
    score: `${m.goals?.home ?? 0}-${m.goals?.away ?? 0}`,
    date: fmtDate(m.fixture?.date)
  }));

  return {
    homeAvgScored: r2(homeAvgScored), homeAvgConceded: r2(homeAvgConceded),
    homeScoreRate: pct(hGames, m => ((m.teams?.home?.id === hId ? m.goals?.home : m.goals?.away) ?? 0) > 0),
    awayAvgScored: r2(awayAvgScored), awayAvgConceded: r2(awayAvgConceded),
    awayScoreRate: pct(aGames, m => ((m.teams?.away?.id === aId ? m.goals?.away : m.goals?.home) ?? 0) > 0),
    lambdaHome: r2(lambdaHome), lambdaAway: r2(lambdaAway), lambdaTotal: r2(lambdaTotal),
    // [P26] SURSĂ UNICĂ de afișare = /api/enrich (Maher+shrinkage+Dixon-Coles). Aceste câmpuri
    // Poisson „simple" (medie λ) rămân DOAR input intern pt predictAllMarkets / fallback —
    // frontend-ul citește exclusiv enrich (_mdEnMerged → d.enrich), nu aceste valori. NU le
    // folosi pentru afișare directă: ar contrazice enrich pe ecran.
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
    const [dbH2H, sbHForm, sbAForm, dbOddsRows, dbLogos, tsH, tsA, liveStats, dbPlayers, dbPred, dbReferee, dbCoaches] = await Promise.all([
      query('SELECT home_team_id, away_team_id, home_goals, away_goals, match_date FROM h2h WHERE (home_team_id=$1 AND away_team_id=$2) OR (home_team_id=$2 AND away_team_id=$1) ORDER BY match_date DESC LIMIT 10', [hId, aId]).catch(() => ({ rows: [] })),
      getFormFromDB(hId),
      getFormFromDB(aId),
      query('SELECT *, bet_name AS market, value_name AS label, value_odd AS odd_value FROM odds WHERE fixture_id=$1 AND bookmaker_id=8', [Number(id)]).catch(() => ({ rows: [] })),
      query('SELECT team_id, name, logo FROM teams WHERE team_id = ANY($1)', [[hId, aId]]).catch(() => ({ rows: [] })),
      getTeamStatsFromDB(hId, null),
      getTeamStatsFromDB(aId, null),
      getLiveStatsFromDB(id),
      getPlayerStatsFromDB(id),
      getPredictionFromDB(id),
      getRefereeFromDB(id),
      getCoachesFromDB(id),
    ]);

    const needH2H   = dbH2H.rows.length   < 3;
    const needHForm = sbHForm.length      < 3;
    const needAForm = sbAForm.length      < 3;
    const needOdds  = dbOddsRows.rows.length === 0;
    // Meci FT/AET/PEN deja colectat de collect-finished → folosim DB, NU mai
    // lovim /fixtures/players (economie call API). player_stats e populată doar
    // pentru meciuri finalizate, deci prezența rândurilor = meci încheiat.
    const useDbPlayers = dbPlayers.length > 0;

    // ── Always fetch fixture details, lineups, events (players doar dacă DB gol) ─
    const [rFix, rLineups, rPlayers, rEvents, rHForm, rAForm, rH2H, rOdds] = await Promise.all([
      fetchApiFootball(`/fixtures?id=${id}`),
      fetchApiFootball(`/fixtures/lineups?fixture=${id}`),
      useDbPlayers ? null : fetchApiFootball(`/fixtures/players?fixture=${id}`),
      fetchApiFootball(`/fixtures/events?fixture=${id}`),
      needHForm ? fetchApiFootball(`/fixtures?team=${h}&last=20&status=FT`) : null,
      needAForm ? fetchApiFootball(`/fixtures?team=${a}&last=20&status=FT`) : null,
      needH2H   ? fetchApiFootball(`/fixtures/headtohead?h2h=${h}-${a}&last=10`) : null,
      needOdds  ? fetchApiFootball(`/odds?fixture=${id}&bookmaker=8`) : null,
    ]);

    const [dFix, dLineups, dEvents] = await Promise.all([
      rFix.json(), rLineups.json(), rEvents.json(),
    ]);
    const dPlayers = useDbPlayers ? null : await rPlayers.json();
    const dHForm = needHForm ? await rHForm.json() : null;
    const dAForm = needAForm ? await rAForm.json() : null;
    const dH2H   = needH2H  ? await rH2H.json()   : null;
    const dOdds  = needOdds  ? await rOdds.json()  : null;

    const teamMap = Object.fromEntries((dbLogos.rows || []).map(r => [Number(r.team_id), { name: r.name, logo: r.logo }]));

    let fixture = (dFix.response || [])[0] || null;

    // Fallback DB când API live întoarce gol (ex. 429 din scanner live) → fixture=null
    // sau fără teams. Reconstruim un fixture minimal din `fixtures` + `teams` ca să nu
    // mai apară „?" la nume/logo în modal. Marcat _degraded → NU se cache-uiește (jos).
    if (!fixture || !fixture.teams || !fixture.teams.home || !fixture.teams.away) {
      let dbRow = null;
      try {
        const fr = await query(
          `SELECT home_team_name, away_team_name, match_date, status_short
             FROM fixtures WHERE fixture_id = $1`,
          [Number(id)]
        );
        dbRow = fr.rows[0] || null;
      } catch (_) {}
      console.warn('[match] fixture degraded → folosind fallback DB pentru', id);
      fixture = {
        fixture: {
          id: Number(id),
          date: dbRow?.match_date || null,
          status: { short: dbRow?.status_short || 'NS', elapsed: null, extra: null },
          referee: null,
        },
        teams: {
          home: { id: hId, name: teamMap[hId]?.name || dbRow?.home_team_name || null, logo: teamMap[hId]?.logo || null },
          away: { id: aId, name: teamMap[aId]?.name || dbRow?.away_team_name || null, logo: teamMap[aId]?.logo || null },
        },
        goals: { home: null, away: null },
        _degraded: true,
      };
    }

    // Inject DB logos where API logo is missing
    if (fixture?.teams?.home) fixture.teams.home.logo = fixture.teams.home.logo || teamMap[hId]?.logo || null;
    if (fixture?.teams?.away) fixture.teams.away.logo = fixture.teams.away.logo || teamMap[aId]?.logo || null;
    // Fallback ARBITRU: când API live nu-l are, folosim valoarea persistată (PAS 1/2).
    if (fixture?.fixture && (!fixture.fixture.referee || fixture.fixture.referee === 'null') && dbReferee) {
      fixture.fixture.referee = dbReferee;
    }
    const lineups = dLineups.response || [];
    const players = useDbPlayers ? [] : (dPlayers.response || []);
    const events  = dEvents.response  || [];

    // FIX gold: salvează formațiile (4-3-3 etc.) în fixtures_history din lineups-ul
    // DEJA cerut. Doar salvare (UPDATE dacă rândul există); nimic nu intră în model.
    try {
      if (lineups.length && fixture?.teams) {
        const _hid = fixture.teams.home?.id, _aid = fixture.teams.away?.id;
        const _fmt = (tid) => { const l = lineups.find(x => x.team?.id === tid); return l?.formation || null; };
        const _hf = _fmt(_hid), _af = _fmt(_aid);
        if (_hf || _af) await query(
          `UPDATE fixtures_history SET home_formation=COALESCE($2,home_formation),
             away_formation=COALESCE($3,away_formation) WHERE fixture_id=$1`,
          [id, _hf, _af]
        ).catch(() => {});
      }
    } catch (_) {}

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

    // ── Predicție pre-calculată (collect-daily) — λ instant pentru NS ─────────
    // Folosește λ din tabela predictions (calcul Poisson pur, fără API), astfel
    // încât modalul afișează aceleași date pre-meci consistente chiar dacă forma
    // on-demand a fost slabă. DOAR pre-meci — blocul live de mai jos are prioritate.
    const _isLiveNow = liveStats && Number(liveStats.elapsed) > 0;
    if (!_isLiveNow && dbPred && dbPred.lambda_home != null && dbPred.lambda_away != null) {
      const r2 = v => Math.round(v * 100) / 100;
      poissonResult.lambdaHome  = r2(Number(dbPred.lambda_home));
      poissonResult.lambdaAway  = r2(Number(dbPred.lambda_away));
      poissonResult.lambdaTotal = r2(poissonResult.lambdaHome + poissonResult.lambdaAway);
      const mxP = calcPoisson6x6(poissonResult.lambdaHome, poissonResult.lambdaAway);
      Object.assign(poissonResult, {
        over15Prob: mxP.over15Prob, over25Prob: mxP.over25Prob,
        ggProb: mxP.ggProb, homeWin: mxP.homeWin,
        draw: mxP.draw, awayWin: mxP.awayWin,
      });
      poissonResult._predSource = 'collect-daily';
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
          h2h_over15 = EXCLUDED.h2h_over15
        WHERE predictions.result_over15 IS NULL
          AND (predictions.match_date IS NULL OR predictions.match_date > NOW())`,
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

    // FT/AET/PEN → din DB (dbPlayers, deja în forma flatPlayers + sortat);
    // altfel → din răspunsul API /fixtures/players.
    const flatPlayers = useDbPlayers ? dbPlayers : players.flatMap(team =>
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
        shots_total:     p.statistics?.[0]?.shots?.total ?? null,
        shots_on_target: p.statistics?.[0]?.shots?.on ?? null,
        position:    p.statistics?.[0]?.games?.position || ''
      }))
    ).sort((a, b) => (b.rating || 0) - (a.rating || 0));

    const responseData = { fixture, lineups, players: flatPlayers, events, enrich, coaches: dbCoaches || {} };

    // Stats per echipă (match_stats — populate de collect-finished + backfill).
    // Răspund cu [home_row, away_row] sau [] dacă datele lipsesc.
    try {
      const { rows: msRows } = await query(
        `SELECT team_id, team_name,
                shots_on_goal, shots_total, blocked_shots,
                shots_insidebox, shots_outsidebox,
                fouls, corner_kicks, offsides,
                ball_possession, yellow_cards, red_cards,
                goalkeeper_saves,
                total_passes, passes_accurate, pass_percentage,
                expected_goals
           FROM match_stats
          WHERE fixture_id = $1`,
        [Number(id)]
      );
      const hRow = msRows.find(r => Number(r.team_id) === Number(hId)) || null;
      const aRow = msRows.find(r => Number(r.team_id) === Number(aId)) || null;
      responseData.matchStats = { home: hRow, away: aRow };
    } catch (e) {
      responseData.matchStats = { home: null, away: null, error: e.message };
    }

    // Cote 1X2 pre-meci (DOAR afișare) — citite din prematch_data (data_type='odds').
    // Feature flag SHOW_MARKET_ODDS; market_odds:null dacă lipsă date sau flag off.
    if (SHOW_MARKET_ODDS) {
      try {
        const { rows: odRows } = await query(
          `SELECT payload FROM prematch_data
            WHERE fixture_id = $1 AND data_type = 'odds'
            ORDER BY collected_at DESC LIMIT 1`,
          [Number(id)]
        );
        responseData.market_odds = odRows.length ? extractMatchWinnerOdds(odRows[0].payload) : null;
      } catch (_) {
        responseData.market_odds = null;
      }
    }

    // ── Statistici LIVE din API (doar meci activ) + ML live-aware ─────────────
    // liveStats e opțional (silent-fail). Când meciul e live, recalculăm predicțiile
    // ML cu context live (minut/scor/HT + statistici reale) → R2 corect.
    const _st = (fixture && fixture.fixture && fixture.fixture.status) || {};
    const _short = _st.short;
    const _isLive = ['1H', '2H', 'HT', 'ET'].includes(_short);
    if (_isLive) {
      try {
        const statsResp = await fetchApiFootball(`/fixtures/statistics?fixture=${id}`);
        const sj = await statsResp.json();
        if (sj && Array.isArray(sj.response) && sj.response.length) {
          // Aliniere home/away după team.id (nu presupune ordinea).
          const byTeam = {};
          for (const blk of sj.response) if (blk && blk.team) byTeam[Number(blk.team.id)] = blk.statistics || [];
          const hArr = byTeam[Number(hId)] || sj.response[0]?.statistics || [];
          const aArr = byTeam[Number(aId)] || sj.response[1]?.statistics || [];
          const getStat = (arr, type) => { const s = (arr || []).find(x => x.type === type); return s && s.value != null ? (parseInt(s.value) || 0) : 0; };
          responseData.liveStats = {
            shots_on_target_home: getStat(hArr, 'Shots on Goal'),
            shots_on_target_away: getStat(aArr, 'Shots on Goal'),
            shots_home: getStat(hArr, 'Total Shots'),
            shots_away: getStat(aArr, 'Total Shots'),
            corners_home: getStat(hArr, 'Corner Kicks'),
            corners_away: getStat(aArr, 'Corner Kicks'),
            possession_home: getStat(hArr, 'Ball Possession') || 50,
            possession_away: getStat(aArr, 'Ball Possession') || 50,
          };
        }
      } catch (_) { /* statistici opționale */ }

      // ELO point-in-time (elo_history) → fallback elo_ratings.
      let eloData = null;
      try {
        const eh = await query(`SELECT home_elo, away_elo, elo_diff, home_win_prob FROM elo_history WHERE fixture_id=$1`, [Number(id)]);
        if (eh.rows[0]) {
          const r = eh.rows[0];
          eloData = { home_elo: Number(r.home_elo), away_elo: Number(r.away_elo), elo_diff: Number(r.elo_diff), home_win_prob: Number(r.home_win_prob) };
        } else {
          const lid = fixture?.league?.id;
          if (lid) {
            const rr = await query(
              `SELECT er_h.elo AS home_elo, er_a.elo AS away_elo FROM elo_ratings er_h
                 JOIN elo_ratings er_a ON er_a.team_id=$2 AND er_a.league_id=$3
                WHERE er_h.team_id=$1 AND er_h.league_id=$3`,
              [Number(hId), Number(aId), Number(lid)]
            );
            if (rr.rows[0]) {
              const r = rr.rows[0], dd = Number(r.home_elo) - Number(r.away_elo);
              eloData = { home_elo: Number(r.home_elo), away_elo: Number(r.away_elo), elo_diff: dd, home_win_prob: 1 / (1 + Math.pow(10, -dd / 400)) };
            }
          }
        }
      } catch (_) {}

      // ML live-aware (predictAllMarkets aplică fulfilled/final + folosește liveStats).
      try {
        const liveCtx = {
          elapsed: _st.elapsed || 0, status: _short,
          homeGoals: fixture.goals?.home ?? 0, awayGoals: fixture.goals?.away ?? 0,
          homeHT: fixture.score?.halftime?.home ?? null, awayHT: fixture.score?.halftime?.away ?? null,
          minutesRemaining: Math.max(0, 90 - (_st.elapsed || 0)),
          liveStats: responseData.liveStats || null,
        };
        const ml = predictAllMarkets(enrich, eloData, liveCtx);
        if (ml) { responseData.mlPredictions = ml; responseData.mlAvailable = true; }
      } catch (_) { /* ML indisponibil */ }
    }

    // NU cache-ui răspunsuri degradate (fixture din fallback DB) → reîncearcă API la următorul fetch.
    if (!fixture._degraded) matchCache.set(id, { data: responseData, ts: Date.now() });
    res.status(200).json(responseData);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
