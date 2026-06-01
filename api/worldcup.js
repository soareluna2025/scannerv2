// api/worldcup.js — Hub CUPA MONDIALĂ 2026 (READ-ONLY, ZERO API-Football).
// GET /api/worldcup → agregă tot din DB, filtrat pe league=1 & season=2026:
//   pontul   — fixtura WC de azi cu cea mai mare confidence (din predictions, NU recalc)
//   matches  — fixturile WC live + următoarele, cu predicțiile existente
//   groups   — standings league=1 season=2026 grupate pe group_name
//   bracket  — fixturile fazelor eliminatorii (round) + TBD
// NU recalculează scoring/NGP — doar citește predicțiile existente și le afișează.

import { query } from './db.js';

const WC_LEAGUE = 1;
const WC_SEASON = 2026;
const LIVE = ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE', 'INT'];
const DONE = ['FT', 'AET', 'PEN'];

// Piața recomandată din predicția existentă (cel mai puternic semnal). NU recalculează —
// alege maximul dintre semnalele deja stocate (over15/over25/gg/1X2).
function pickMarket(p) {
  const cands = [
    { market: 'Over 1.5', prob: num(p.over15_prob) },
    { market: 'Over 2.5', prob: num(p.over25_prob) },
    { market: 'GG (ambele marchează)', prob: num(p.gg_prob) },
    { market: '1 (gazde)', prob: num(p.home_win_prob) },
    { market: 'X (egal)',  prob: num(p.draw_prob) },
    { market: '2 (oaspeți)', prob: num(p.away_win_prob) },
  ].filter(c => c.prob != null);
  if (!cands.length) return null;
  cands.sort((a, b) => b.prob - a.prob);
  return cands[0];
}
function num(v) { return v == null ? null : Number(v); }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── MATCHES: fixturile WC live + următoarele (azi înainte), cu predicții ──
    const matchesRes = await query(
      `SELECT f.fixture_id, f.home_team_name, f.away_team_name, f.home_team_id, f.away_team_id,
              f.status_short, f.match_date, f.home_goals, f.away_goals, f.round,
              p.over15_prob, p.over25_prob, p.gg_prob,
              p.home_win_prob, p.draw_prob, p.away_win_prob, p.confidence, p.best_bet, p.best_cota,
              ls.ngp_home, ls.ngp_away, ls.elapsed AS ls_elapsed
         FROM fixtures f
         LEFT JOIN predictions p ON p.fixture_id = f.fixture_id
         LEFT JOIN LATERAL (
           SELECT ngp_home, ngp_away, elapsed FROM live_stats
            WHERE fixture_id = f.fixture_id ORDER BY recorded_at DESC LIMIT 1
         ) ls ON TRUE
        WHERE f.league_id = $1 AND (f.season = $2 OR f.season IS NULL)
          AND (f.status_short = ANY($3) OR f.match_date >= NOW() - INTERVAL '3 hours')
          AND f.status_short <> ALL($4)
        ORDER BY
          CASE WHEN f.status_short = ANY($3) THEN 0 ELSE 1 END,
          f.match_date ASC
        LIMIT 60`,
      [WC_LEAGUE, WC_SEASON, LIVE, DONE]
    ).catch(() => ({ rows: [] }));

    const matches = matchesRes.rows.map(m => {
      const isLive = LIVE.includes(m.status_short);
      const ng = isLive ? Math.max(num(m.ngp_home) || 0, num(m.ngp_away) || 0) : null;
      return {
        fixtureId: m.fixture_id,
        home: m.home_team_name, away: m.away_team_name,
        homeId: m.home_team_id, awayId: m.away_team_id,
        status: m.status_short, matchDate: m.match_date,
        homeGoals: m.home_goals, awayGoals: m.away_goals,
        round: m.round, live: isLive,
        ng,                                  // NGP live (din live_stats, fără recalcul)
        over15: num(m.over15_prob), over25: num(m.over25_prob), gg: num(m.gg_prob),
        homeWin: num(m.home_win_prob), draw: num(m.draw_prob), awayWin: num(m.away_win_prob),
        confidence: num(m.confidence),
      };
    });

    // ── PONTUL: fixtura WC de AZI cu cea mai mare confidence (din predictions) ──
    const pontRes = await query(
      `SELECT p.fixture_id, p.home_team, p.away_team, p.match_date, p.confidence,
              p.over15_prob, p.over25_prob, p.gg_prob,
              p.home_win_prob, p.draw_prob, p.away_win_prob, p.best_bet, p.best_cota
         FROM predictions p
         JOIN fixtures f ON f.fixture_id = p.fixture_id
        WHERE p.league_id = $1
          AND f.match_date::date = NOW()::date
          AND f.status_short <> ALL($2)
          AND p.confidence IS NOT NULL
        ORDER BY p.confidence DESC
        LIMIT 1`,
      [WC_LEAGUE, DONE]
    ).catch(() => ({ rows: [] }));

    let pont = null;
    if (pontRes.rows[0]) {
      const p = pontRes.rows[0];
      const mk = pickMarket(p);
      pont = {
        fixtureId: p.fixture_id,
        home: p.home_team, away: p.away_team,
        matchDate: p.match_date,
        confidence: num(p.confidence),
        market: mk ? mk.market : (p.best_bet || null),
        marketProb: mk ? Math.round(mk.prob) : null,
        cota: p.best_cota != null ? Number(p.best_cota) : null, // omisă în UI dacă null
      };
    }

    // ── GROUPS: standings league=1 season=2026 grupate pe group_name ──
    const stRes = await query(
      `SELECT team_id, team_name, team_logo, rank, played, win, draw, lose,
              goals_for, goals_against, goals_diff, points, group_name
         FROM standings
        WHERE league_id = $1 AND season = $2
        ORDER BY group_name NULLS LAST, rank ASC`,
      [WC_LEAGUE, WC_SEASON]
    ).catch(() => ({ rows: [] }));

    const groupsMap = {};
    for (const r of stRes.rows) {
      const g = r.group_name || 'Grupă';
      (groupsMap[g] = groupsMap[g] || []).push({
        teamId: r.team_id, teamName: r.team_name, teamLogo: r.team_logo,
        rank: r.rank, played: r.played, win: r.win, draw: r.draw, lose: r.lose,
        goalsFor: r.goals_for, goalsAgainst: r.goals_against,
        goalsDiff: r.goals_diff, points: r.points,
      });
    }
    const groups = Object.keys(groupsMap).sort().map(name => ({ name, rows: groupsMap[name] }));

    // ── BRACKET: fixturile fazelor eliminatorii (round conține knockout) ──
    const brRes = await query(
      `SELECT fixture_id, home_team_name, away_team_name, home_goals, away_goals,
              status_short, match_date, round
         FROM fixtures
        WHERE league_id = $1 AND (season = $2 OR season IS NULL)
          AND round IS NOT NULL
          AND (round ILIKE '%final%' OR round ILIKE '%16%' OR round ILIKE '%quarter%'
               OR round ILIKE '%semi%' OR round ILIKE '%sfert%' OR round ILIKE '%optimi%'
               OR round ILIKE '%knockout%' OR round ILIKE '%round of%')
        ORDER BY match_date ASC NULLS LAST`,
      [WC_LEAGUE, WC_SEASON]
    ).catch(() => ({ rows: [] }));

    // Grupare pe rundă; meciuri nedeterminate (fără echipe) = TBD.
    const brMap = {};
    for (const r of brRes.rows) {
      const round = r.round || 'Knockout';
      (brMap[round] = brMap[round] || []).push({
        fixtureId: r.fixture_id,
        home: r.home_team_name || 'TBD',
        away: r.away_team_name || 'TBD',
        homeGoals: r.home_goals, awayGoals: r.away_goals,
        status: r.status_short, matchDate: r.match_date,
        tbd: !r.home_team_name || !r.away_team_name,
      });
    }
    const bracket = Object.keys(brMap).map(round => ({ round, matches: brMap[round] }));

    res.status(200).json({
      ok: true,
      league: WC_LEAGUE, season: WC_SEASON,
      liveCount: matches.filter(m => m.live).length,
      pont, matches, groups, bracket,
      source: 'db',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
