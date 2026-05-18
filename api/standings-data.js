import { query } from './db.js';

const currentSeason = () => {
  const m = new Date().getMonth(); // 0=Jan
  return m >= 7 ? new Date().getFullYear() : new Date().getFullYear() - 1;
};

async function fromDB(leagueId, season) {
  try {
    const r = await query(
      `SELECT team_id, team_name, team_logo, rank, played, win, draw, lose,
              goals_for, goals_against, goals_diff, points
       FROM standings WHERE league_id=$1 AND season=$2 ORDER BY rank ASC`,
      [leagueId, season]
    );
    return r.rows;
  } catch (_) { return []; }
}

async function fromAPI(leagueId, season, key) {
  try {
    const r = await fetch(
      `https://v3.football.api-sports.io/standings?league=${leagueId}&season=${season}`,
      { headers: { 'x-apisports-key': key } }
    );
    const d = await r.json();
    const list = d.response?.[0]?.league?.standings?.[0] || [];
    return list.map(t => ({
      rank:           t.rank || 0,
      team_id:        t.team?.id,
      team_name:      t.team?.name    || '?',
      team_logo:      t.team?.logo    || null,
      played:         t.all?.played   || 0,
      win:            t.all?.win      || 0,
      draw:           t.all?.draw     || 0,
      lose:           t.all?.lose     || 0,
      goals_for:      t.all?.goals?.for     || 0,
      goals_against:  t.all?.goals?.against || 0,
      goals_diff:     t.goalsDiff     || 0,
      points:         t.points        || 0,
    }));
  } catch (_) { return []; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { league, season, hid, aid } = req.query;
  const leagueId = Number(league);
  const seasonY  = Number(season) || currentSeason();
  const homeId   = Number(hid);
  const awayId   = Number(aid);

  if (!leagueId) return res.status(400).json({ error: 'league required' });

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;

  let rows = await fromDB(leagueId, seasonY);
  if (!rows.length && key) rows = await fromAPI(leagueId, seasonY, key);

  const homeRow  = rows.find(r => Number(r.team_id) === homeId) || null;
  const awayRow  = rows.find(r => Number(r.team_id) === awayId) || null;

  res.status(200).json({
    standings:  rows,
    homeTeamId: homeId,
    awayTeamId: awayId,
    homeRank:   homeRow ? Number(homeRow.rank)   : null,
    awayRank:   awayRow ? Number(awayRow.rank)   : null,
    homePoints: homeRow ? Number(homeRow.points) : null,
    awayPoints: awayRow ? Number(awayRow.points) : null,
    season:     seasonY,
    source:     rows.length ? 'db' : 'none',
  });
}
