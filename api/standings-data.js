import { query } from './db.js';
import { seasonForDate } from './utils/season.js';

// Cutoff unificat (august) — sursă unică în utils/season.js.
const currentSeason = () => seasonForDate();

// Coloanele complete (inclusiv group_name/form/description — necesare pt modul grupă).
const COLS = `team_id, team_name, team_logo, rank, played, win, draw, lose,
  goals_for, goals_against, goals_diff, points, group_name, form, description`;

// Clasamentul general al ligii (fallback).
async function leagueFromDB(leagueId, season) {
  try {
    const r = await query(
      `SELECT ${COLS} FROM standings WHERE league_id=$1 AND season=$2 ORDER BY rank ASC`,
      [leagueId, season]
    );
    return r.rows;
  } catch (_) { return []; }
}

// Grupa în care e o echipă (null dacă liga n-are grupe sau echipa lipsește).
async function groupForTeam(leagueId, season, teamId) {
  if (!teamId) return null;
  try {
    const r = await query(
      `SELECT group_name FROM standings
       WHERE league_id=$1 AND season=$2 AND team_id=$3 LIMIT 1`,
      [leagueId, season, teamId]
    );
    return r.rows[0]?.group_name || null;
  } catch (_) { return null; }
}

// Toate echipele din una sau mai multe grupe.
async function teamsInGroups(leagueId, season, groups) {
  try {
    const r = await query(
      `SELECT ${COLS} FROM standings
       WHERE league_id=$1 AND season=$2 AND group_name = ANY($3)
       ORDER BY group_name ASC, rank ASC`,
      [leagueId, season, groups]
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
      group_name:     t.group         || null,
      form:           t.form          || null,
      description:    t.description   || null,
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

  let rows = [];
  let source = 'none';
  let groupName = null;

  // 1) Încearcă grupa specifică a echipelor (doar din DB — standings).
  const homeGroup = await groupForTeam(leagueId, seasonY, homeId);
  if (homeGroup) {
    const awayGroup = await groupForTeam(leagueId, seasonY, awayId);
    // Dacă-s în grupe diferite → returnează ambele grupe.
    const groups = (awayGroup && awayGroup !== homeGroup) ? [homeGroup, awayGroup] : [homeGroup];
    rows = await teamsInGroups(leagueId, seasonY, groups);
    if (rows.length) {
      source = 'group';
      groupName = groups.join(' / ');
    }
  }

  // 2) Fallback: clasamentul general (DB, apoi API).
  if (!rows.length) {
    rows = await leagueFromDB(leagueId, seasonY);
    if (!rows.length && key) rows = await fromAPI(leagueId, seasonY, key);
    source = rows.length ? 'league' : 'none';
  }

  // Flag-uri per rând (echipa gazdă / oaspete).
  rows = rows.map(r => ({
    ...r,
    isHome: Number(r.team_id) === homeId,
    isAway: Number(r.team_id) === awayId,
  }));

  const homeRow = rows.find(r => r.isHome) || null;
  const awayRow = rows.find(r => r.isAway) || null;

  res.status(200).json({
    standings:  rows,
    groupName,
    homeTeamId: homeId,
    awayTeamId: awayId,
    homeRank:   homeRow ? Number(homeRow.rank)   : null,
    awayRank:   awayRow ? Number(awayRow.rank)   : null,
    homePoints: homeRow ? Number(homeRow.points) : null,
    awayPoints: awayRow ? Number(awayRow.points) : null,
    season:     seasonY,
    source,
  });
}
