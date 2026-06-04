// api/worldcup-qualifiers.js — Tab CALIFICĂRI CM 2026 (READ-ONLY, ZERO API-Football).
// GET /api/worldcup-qualifiers → agregă din DB standings + fixtures pe confederații.
// Datele sunt colectate de cron-ul api/cron/collect-wc-qualifiers.js.
//
// Structură: confederations[] → groups[] → { standings[], fixtures[] }.
// fixtures_history nu are coloană group_name, deci meciurile se atribuie grupei
// după apartenența echipelor (home/away ∈ teams din standings-ul grupei).

import { query } from './db.js';

// Ligile calificărilor + maparea confederației + ordinea de afișare cerută.
const QUAL_LEAGUES = [29, 30, 31, 32, 33, 34];
const CONF_BY_LEAGUE = {
  29: 'Africa', 30: 'Asia', 31: 'CONCACAF',
  32: 'Europe', 33: 'Oceania', 34: 'South America',
};
// Ordine: Europe, Africa, Asia, CONCACAF, South America, Oceania
const DISPLAY_ORDER = [32, 29, 30, 31, 34, 33];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── STANDINGS (toate sezoanele din set, grupate ulterior) ──
    const stRes = await query(
      `SELECT s.league_id, s.season, s.rank, s.team_id, s.team_name, s.team_logo,
              s.played, s.win, s.draw, s.lose, s.goals_for, s.goals_against,
              s.goals_diff, s.points, s.group_name, s.description,
              l.name AS league_name
         FROM standings s
         JOIN leagues l ON l.league_id = s.league_id
        WHERE s.league_id = ANY($1)
        ORDER BY s.league_id, s.season, s.group_name NULLS LAST, s.rank ASC`,
      [QUAL_LEAGUES]
    ).catch(() => ({ rows: [] }));

    // Per ligă alegem sezonul cel mai recent prezent în standings (= tabela curentă
    // a calificărilor). Diferă legitim între confederații (UEFA 2024, CAF 2023, etc.).
    const targetSeason = {};
    for (const r of stRes.rows) {
      if (targetSeason[r.league_id] == null || r.season > targetSeason[r.league_id]) {
        targetSeason[r.league_id] = r.season;
      }
    }

    // ── FIXTURES + goluri (match_events type='Goal') ──
    const fxRes = await query(
      `SELECT fh.fixture_id, fh.league_id, fh.season, fh.match_date,
              fh.home_team_id, fh.home_team_name, fh.away_team_id, fh.away_team_name,
              fh.home_goals, fh.away_goals, fh.home_ht, fh.away_ht,
              me.elapsed, me.player_name, me.team_id AS event_team_id, me.detail
         FROM fixtures_history fh
         LEFT JOIN match_events me ON me.fixture_id = fh.fixture_id AND me.type = 'Goal'
        WHERE fh.league_id = ANY($1)
        ORDER BY fh.league_id, fh.match_date ASC, me.elapsed ASC NULLS LAST`,
      [QUAL_LEAGUES]
    ).catch(() => ({ rows: [] }));

    // Aglomerăm rândurile (1/gol) într-un singur obiect fixture cu events[].
    const fxMap = new Map();
    for (const r of fxRes.rows) {
      let f = fxMap.get(r.fixture_id);
      if (!f) {
        f = {
          fixture_id: r.fixture_id,
          league_id: r.league_id,
          season: r.season,
          match_date: r.match_date,
          home_team_id: r.home_team_id,
          away_team_id: r.away_team_id,
          home_team_name: r.home_team_name,
          away_team_name: r.away_team_name,
          home_goals: r.home_goals,
          away_goals: r.away_goals,
          home_ht: r.home_ht,
          away_ht: r.away_ht,
          events: [],
        };
        fxMap.set(r.fixture_id, f);
      }
      if (r.elapsed != null && r.player_name) {
        f.events.push({
          elapsed: r.elapsed,
          player_name: r.player_name,
          team_id: r.event_team_id,
          detail: r.detail,
        });
      }
    }

    // ── Construim confederațiile ──
    const confederations = [];
    for (const leagueId of DISPLAY_ORDER) {
      const season = targetSeason[leagueId];
      if (season == null) continue;   // nimic colectat încă pt liga asta

      // Standings ale sezonului țintă, grupate pe group_name.
      const stRows = stRes.rows.filter(r => r.league_id === leagueId && r.season === season);
      if (!stRows.length) continue;

      const groupsMap = {};                 // groupName → standings[]
      const teamGroup = new Map();          // team_id → groupName (pt atribuirea meciurilor)
      for (const r of stRows) {
        const g = r.group_name || 'Clasament';
        (groupsMap[g] = groupsMap[g] || []).push({
          rank: r.rank, team_id: r.team_id, team_name: r.team_name, team_logo: r.team_logo,
          played: r.played, win: r.win, draw: r.draw, lose: r.lose,
          goals_for: r.goals_for, goals_against: r.goals_against,
          goals_diff: r.goals_diff, points: r.points, description: r.description,
        });
        teamGroup.set(r.team_id, g);
      }

      // Meciurile sezonului țintă, atribuite grupei după apartenența echipelor.
      const groupFixtures = {};
      for (const f of fxMap.values()) {
        if (f.league_id !== leagueId || f.season !== season) continue;
        const g = teamGroup.get(f.home_team_id) || teamGroup.get(f.away_team_id);
        if (!g) continue;
        (groupFixtures[g] = groupFixtures[g] || []).push({
          fixture_id: f.fixture_id,
          match_date: f.match_date,
          home_team_name: f.home_team_name,
          away_team_name: f.away_team_name,
          home_goals: f.home_goals,
          away_goals: f.away_goals,
          home_ht: f.home_ht,
          away_ht: f.away_ht,
          events: f.events.sort((a, b) => (a.elapsed || 0) - (b.elapsed || 0)),
        });
      }

      const groups = Object.keys(groupsMap).sort().map(name => ({
        name,
        standings: groupsMap[name],
        fixtures: (groupFixtures[name] || []).sort(
          (a, b) => new Date(a.match_date || 0) - new Date(b.match_date || 0)
        ),
      }));

      confederations.push({
        name: CONF_BY_LEAGUE[leagueId],
        league_id: leagueId,
        season,
        groups,
      });
    }

    res.status(200).json({ ok: true, confederations, source: 'db' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
