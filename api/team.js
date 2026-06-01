// api/team.js — Pagina de ECHIPĂ (READ-ONLY, ZERO API-Football).
// GET /api/team?id=<teamId>[&league_id=][&season=]
// Refolosit din pagina de meci (tap pe logo/nume echipă), încărcat după team_id.
// Returnează: meta (echipă/ligă/loc), players (lot pe poziții), form (ultimele meciuri),
//   standings (clasament calculat din fixtures_history), stats (agregate + teamStrength).
// TOTUL din DB. NU recalculează score7 — citește puterea echipei cu aceeași formulă
// de citire ca getTeamStrengths() din enrich.js (read-only pe player_stats).

import { query } from './db.js';

// Sezon CURENT per ligă DIN DB (zero API): cel mai mare `season` din standings
// pentru liga dată (sursa de adevăr per-ligă, populată de collect-daily), cu
// fallback pe max(season) din fixtures_history. Așa nu amestecăm sezoane între
// ligi europene (2025/26) și cele pe an calendaristic (2026).
async function seasonForLeagueDB(leagueId) {
  if (!leagueId) return null;
  try {
    const r = await query(
      `SELECT MAX(season) AS s FROM standings WHERE league_id=$1`, [leagueId]);
    if (r.rows[0]?.s != null) return Number(r.rows[0].s);
  } catch (_) {}
  try {
    const r = await query(
      `SELECT MAX(season) AS s FROM fixtures_history WHERE league_id=$1`, [leagueId]);
    if (r.rows[0]?.s != null) return Number(r.rows[0].s);
  } catch (_) {}
  return null;
}

// Liga „principală" a echipei DIN DB: standings (cel mai recent sezon) →
// fallback pe ultimul meci din fixtures_history.
async function leagueForTeamDB(teamId) {
  try {
    const r = await query(
      `SELECT league_id FROM standings WHERE team_id=$1 ORDER BY season DESC LIMIT 1`,
      [teamId]);
    if (r.rows[0]?.league_id != null) return Number(r.rows[0].league_id);
  } catch (_) {}
  try {
    const r = await query(
      `SELECT league_id FROM fixtures_history
        WHERE (home_team_id=$1 OR away_team_id=$1) AND league_id IS NOT NULL
        ORDER BY match_date DESC LIMIT 1`, [teamId]);
    if (r.rows[0]?.league_id != null) return Number(r.rows[0].league_id);
  } catch (_) {}
  return null;
}

// Normalizează poziția API-Football (G/D/M/F sau cuvânt) la grupa noastră.
function posGroup(position) {
  const p = String(position || '').trim().toUpperCase();
  if (p === 'G' || p.startsWith('GOAL') || p.startsWith('POR')) return 'G';
  if (p === 'D' || p.startsWith('DEF') || p.startsWith('FUND')) return 'D';
  if (p === 'M' || p.startsWith('MID') || p.startsWith('MIJ'))  return 'M';
  if (p === 'F' || p.startsWith('ATT') || p.startsWith('FOR') || p.startsWith('ATA')) return 'F';
  return 'M'; // necunoscut → mijloc (neutru)
}

// LOT pe poziții: agregat per jucător din player_stats pentru sezonul curent.
// Sezonul player_stats nu e stocat direct → join pe fixtures_history DOAR pe season
// (NU pe league_id): lotul se adună pe TOATE competițiile sezonului. Filtrul pe
// league_id excludea greșit jucătorii când statisticile sunt sub altă competiție
// (ex. Liverpool Montevideo: stats pe Copa Libertadores 13, nu pe campionatul intern).
async function getPlayers(teamId, season) {
  let rows = [];
  try {
    const r = await query(
      `SELECT ps.player_id, ps.player_name, ps.position,
              COUNT(DISTINCT ps.fixture_id)::int            AS apps,
              COALESCE(SUM(ps.goals),0)::int                AS goals,
              COALESCE(SUM(ps.assists),0)::int              AS assists,
              COALESCE(SUM(ps.yellow_cards),0)::int         AS yellows,
              COALESCE(SUM(ps.red_cards),0)::int            AS reds,
              ROUND(AVG(ps.rating) FILTER (WHERE ps.rating IS NOT NULL),2) AS avg_rating,
              COALESCE(SUM(ps.minutes_played),0)::int       AS minutes
         FROM player_stats ps
         JOIN fixtures_history fh ON fh.fixture_id = ps.fixture_id
        WHERE ps.team_id = $1 AND fh.season = $2
        GROUP BY ps.player_id, ps.player_name, ps.position
        ORDER BY goals DESC, assists DESC, avg_rating DESC NULLS LAST`,
      [teamId, season]);
    rows = r.rows;
  } catch (_) { rows = []; }

  // Clean sheets per jucător de câmp nu există direct; calculăm clean sheets ECHIPĂ
  // (folosit la portari). Atașăm la grup-ul G mai jos.
  const groups = { G: [], D: [], M: [], F: [] };
  for (const p of rows) {
    groups[posGroup(p.position)].push({
      playerId:  p.player_id,
      name:      p.player_name || '?',
      position:  p.position || '',
      apps:      Number(p.apps) || 0,
      goals:     Number(p.goals) || 0,
      assists:   Number(p.assists) || 0,
      yellows:   Number(p.yellows) || 0,
      reds:      Number(p.reds) || 0,
      rating:    p.avg_rating != null ? Number(p.avg_rating) : null,
      minutes:   Number(p.minutes) || 0,
    });
  }
  return groups;
}

// FORMĂ: ultimele ~18 meciuri finalizate (team ca home SAU away). Folosește
// idx_fh_home_status_date / idx_fh_away_status_date prin UNION.
async function getForm(teamId, limit = 18) {
  try {
    const r = await query(
      `SELECT fixture_id, match_date, home_team_id, away_team_id,
              home_team_name, away_team_name, home_goals, away_goals
         FROM fixtures_history
        WHERE (home_team_id=$1 OR away_team_id=$1)
          AND status_short IN ('FT','AET','PEN')
          AND home_goals IS NOT NULL AND away_goals IS NOT NULL
        ORDER BY match_date DESC
        LIMIT $2`, [teamId, limit]);
    return r.rows.map(m => {
      const isHome = Number(m.home_team_id) === Number(teamId);
      const gf = isHome ? m.home_goals : m.away_goals;
      const ga = isHome ? m.away_goals : m.home_goals;
      // W/D/L — aceeași convenție ca badge-urile .md-form-badge din CSS existent.
      const result = gf > ga ? 'W' : gf < ga ? 'L' : 'D';
      const opponent = isHome ? (m.away_team_name || '?') : (m.home_team_name || '?');
      return {
        fixtureId: m.fixture_id,
        date:      m.match_date,
        result,
        score:     `${m.home_goals}-${m.away_goals}`,
        opponent,
        home:      isHome,
        gf, ga,
      };
    });
  } catch (_) { return []; }
}

// CLASAMENT calculat din fixtures_history (GROUP BY echipă pe league_id+sezon).
// Puncte: V=3, E=1. Folosește idx_fh_league_status.
async function getStandings(leagueId, season) {
  try {
    const r = await query(
      `WITH games AS (
         SELECT home_team_id AS tid, home_team_name AS tname,
                home_goals AS gf, away_goals AS ga
           FROM fixtures_history
          WHERE league_id=$1 AND season=$2 AND status_short IN ('FT','AET','PEN')
            AND home_goals IS NOT NULL AND away_goals IS NOT NULL
         UNION ALL
         SELECT away_team_id AS tid, away_team_name AS tname,
                away_goals AS gf, home_goals AS ga
           FROM fixtures_history
          WHERE league_id=$1 AND season=$2 AND status_short IN ('FT','AET','PEN')
            AND home_goals IS NOT NULL AND away_goals IS NOT NULL
       )
       SELECT g.tid AS team_id,
              MAX(g.tname) AS team_name,
              COUNT(*)::int AS played,
              SUM(CASE WHEN g.gf>g.ga THEN 1 ELSE 0 END)::int AS win,
              SUM(CASE WHEN g.gf=g.ga THEN 1 ELSE 0 END)::int AS draw,
              SUM(CASE WHEN g.gf<g.ga THEN 1 ELSE 0 END)::int AS lose,
              SUM(g.gf)::int AS goals_for,
              SUM(g.ga)::int AS goals_against,
              (SUM(g.gf)-SUM(g.ga))::int AS goals_diff,
              (SUM(CASE WHEN g.gf>g.ga THEN 3 WHEN g.gf=g.ga THEN 1 ELSE 0 END))::int AS points
         FROM games g
        WHERE g.tid IS NOT NULL
        GROUP BY g.tid
        ORDER BY points DESC, goals_diff DESC, goals_for DESC`,
      [leagueId, season]);
    // logo din teams (separat, ca să nu îngreunăm GROUP BY)
    const rows = r.rows;
    const ids = rows.map(x => x.team_id);
    let logos = {};
    if (ids.length) {
      try {
        const lr = await query(`SELECT team_id, logo FROM teams WHERE team_id = ANY($1)`, [ids]);
        for (const t of lr.rows) logos[t.team_id] = t.logo;
      } catch (_) {}
    }
    return rows.map((x, i) => ({
      rank:          i + 1,
      team_id:       x.team_id,
      team_name:     x.team_name || '?',
      team_logo:     logos[x.team_id] || null,
      played:        x.played,
      win:           x.win,
      draw:          x.draw,
      lose:          x.lose,
      goals_for:     x.goals_for,
      goals_against: x.goals_against,
      goals_diff:    x.goals_diff,
      points:        x.points,
    }));
  } catch (_) { return []; }
}

// STATISTICI agregate din fixtures_history + Putere Echipă (citită, NU recalculată
// score7). Aceeași formulă de citire ca getTeamStrengths() din enrich.js.
async function getStats(teamId) {
  const out = { played: 0, gf: 0, ga: 0, gfPerGame: null, gaPerGame: null,
                cleanSheets: 0, failedToScore: 0, teamStrength: null };
  try {
    const r = await query(
      `SELECT
         COUNT(*)::int AS played,
         SUM(CASE WHEN home_team_id=$1 THEN home_goals ELSE away_goals END)::int AS gf,
         SUM(CASE WHEN home_team_id=$1 THEN away_goals ELSE home_goals END)::int AS ga,
         SUM(CASE WHEN (home_team_id=$1 AND away_goals=0) OR (away_team_id=$1 AND home_goals=0) THEN 1 ELSE 0 END)::int AS clean_sheets,
         SUM(CASE WHEN (home_team_id=$1 AND home_goals=0) OR (away_team_id=$1 AND away_goals=0) THEN 1 ELSE 0 END)::int AS failed_to_score
       FROM fixtures_history
      WHERE (home_team_id=$1 OR away_team_id=$1)
        AND status_short IN ('FT','AET','PEN')
        AND home_goals IS NOT NULL AND away_goals IS NOT NULL`,
      [teamId]);
    const s = r.rows[0] || {};
    out.played = Number(s.played) || 0;
    out.gf = Number(s.gf) || 0;
    out.ga = Number(s.ga) || 0;
    out.cleanSheets = Number(s.clean_sheets) || 0;
    out.failedToScore = Number(s.failed_to_score) || 0;
    if (out.played > 0) {
      out.gfPerGame = +(out.gf / out.played).toFixed(2);
      out.gaPerGame = +(out.ga / out.played).toFixed(2);
    }
  } catch (_) {}

  // Putere Echipă — citire identică cu getTeamStrengths() (enrich.js), READ-ONLY.
  // NU e score7 (acela e match-up între 2 echipe); e teamStrength brut al echipei.
  try {
    const { rows } = await query(
      `SELECT rating, goals, pass_accuracy, shots_on_target
         FROM player_stats WHERE team_id=$1 ORDER BY fixture_id DESC LIMIT 110`, [teamId]);
    if (Array.isArray(rows) && rows.length >= 10) {
      const rated = rows.filter(r => r.rating);
      const avgRating = rated.length ? rated.reduce((a, r) => a + Number(r.rating), 0) / rated.length : 5;
      const goalsPerGame = rows.reduce((a, r) => a + (r.goals || 0), 0) / rows.length;
      const withPass = rows.filter(r => r.pass_accuracy != null);
      const avgPassAcc = withPass.length ? withPass.reduce((a, r) => a + Number(r.pass_accuracy), 0) / withPass.length : 50;
      const avgSot = rows.reduce((a, r) => a + (r.shots_on_target || 0), 0) / rows.length;
      const topScorer = Math.max(...rows.map(r => r.goals || 0), 0);
      out.teamStrength = Math.round(
        (avgRating / 10 * 100) * 0.35 +
        Math.min(100, goalsPerGame * 35) * 0.25 +
        avgPassAcc * 0.20 +
        Math.min(100, avgSot * 12) * 0.10 +
        Math.min(100, topScorer * 20) * 0.10
      );
    }
  } catch (_) {}
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const teamId = Number(req.query?.id);
  if (!teamId) return res.status(400).json({ error: 'team id required' });

  try {
    const leagueId = Number(req.query?.league_id) || await leagueForTeamDB(teamId);
    const season   = Number(req.query?.season)    || await seasonForLeagueDB(leagueId);

    // Meta echipă + ligă (din teams + leagues, read-only)
    let meta = { teamId, teamName: null, logo: null, country: null,
                 leagueId, leagueName: null, season };
    try {
      const t = await query(`SELECT name, logo, country FROM teams WHERE team_id=$1`, [teamId]);
      if (t.rows[0]) { meta.teamName = t.rows[0].name; meta.logo = t.rows[0].logo; meta.country = t.rows[0].country; }
    } catch (_) {}
    if (leagueId) {
      try {
        const l = await query(`SELECT name, country FROM leagues WHERE league_id=$1`, [leagueId]);
        if (l.rows[0]) { meta.leagueName = l.rows[0].name; if (!meta.country) meta.country = l.rows[0].country; }
      } catch (_) {}
    }

    const [players, form, standings, stats] = await Promise.all([
      season ? getPlayers(teamId, season) : Promise.resolve({ G: [], D: [], M: [], F: [] }),
      getForm(teamId),
      (leagueId && season) ? getStandings(leagueId, season) : Promise.resolve([]),
      getStats(teamId),
    ]);

    // Rank curent al echipei în clasamentul calculat
    const myRow = standings.find(r => Number(r.team_id) === teamId) || null;
    meta.rank = myRow ? myRow.rank : null;

    res.status(200).json({
      ok: true,
      meta,
      players,
      form,
      standings,
      stats,
      source: 'db',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
