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

    // ── FIXTURES + evenimente (goluri+cartonașe) + statistici per echipă ──
    // json_agg în subquery evită produsul cartezian (events × stats) și întoarce
    // direct array-uri parsate de driver-ul pg.
    const fxRes = await query(
      `SELECT fh.fixture_id, fh.league_id, fh.season, fh.match_date,
              fh.home_team_id, fh.home_team_name, fh.away_team_id, fh.away_team_name,
              fh.home_goals, fh.away_goals, fh.home_ht, fh.away_ht,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'elapsed', me.elapsed, 'player_name', me.player_name,
                  'assist_name', me.assist_name, 'team_id', me.team_id,
                  'type', me.type, 'detail', me.detail)
                  ORDER BY me.elapsed ASC NULLS LAST)
                FROM match_events me
                WHERE me.fixture_id = fh.fixture_id AND me.type IN ('Goal','Card')
              ), '[]') AS events,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'team_id', ms.team_id, 'team_name', ms.team_name,
                  'ball_possession', ms.ball_possession,
                  'shots_on_goal', ms.shots_on_goal, 'shots_total', ms.shots_total,
                  'corner_kicks', ms.corner_kicks, 'expected_goals', ms.expected_goals,
                  'yellow_cards', ms.yellow_cards, 'red_cards', ms.red_cards))
                FROM match_stats ms WHERE ms.fixture_id = fh.fixture_id
              ), '[]') AS stats
         FROM fixtures_history fh
        WHERE fh.league_id = ANY($1)
        ORDER BY fh.league_id, fh.match_date ASC`,
      [QUAL_LEAGUES]
    ).catch(() => ({ rows: [] }));

    // Un rând per fixture (events/stats sunt deja array-uri JSON).
    const fxMap = new Map();
    for (const r of fxRes.rows) {
      fxMap.set(r.fixture_id, {
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
        events: Array.isArray(r.events) ? r.events : [],
        stats: Array.isArray(r.stats) ? r.stats : [],
      });
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
          home_team_id: f.home_team_id,
          away_team_id: f.away_team_id,
          home_team_name: f.home_team_name,
          away_team_name: f.away_team_name,
          home_goals: f.home_goals,
          away_goals: f.away_goals,
          home_ht: f.home_ht,
          away_ht: f.away_ht,
          score_ht: { home: f.home_ht, away: f.away_ht },
          events: f.events,
          stats: f.stats,
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
