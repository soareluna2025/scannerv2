// Cron: colectare statistici per echipa per liga/sezon din API-Football
// Endpoint: /teams/statistics?league=X&season=Y&team=Z
// Populeaza tabelul teams_stats (avg goluri, clean sheets, played etc.)
// Folosit in enrich.js -> getTeamStatsFromDB ca fallback cand form insuficient.
//
// Trigger: GET /api/cron/collect-team-stats
// Cron: 0 6 * * 1 (luni 06:00, dupa collect-coaches)
// Cost API: 40 call/run, ~350ms/call = ~14s total

import { query } from '../db.js';
import { fetchApiFootball } from '../utils/fetch-api.js';

const LIMIT = 40;
const CURRENT_SEASON = 2025;

async function collectOne(teamId, leagueId, season) {
  try {
    const r = await fetchApiFootball(`/teams/statistics?league=${leagueId}&season=${season}&team=${teamId}`);
    const d = await r.json();
    const s = d.response;
    if (!s || !s.fixtures) return null;

    const fx = s.fixtures;
    const gf = s.goals?.for;
    const ga = s.goals?.against;
    const cs = s.clean_sheet;

    const playedHome  = fx.played?.home  ?? 0;
    const playedAway  = fx.played?.away  ?? 0;
    const playedTotal = fx.played?.total ?? 0;

    const goalsForHome  = gf?.total?.home  ?? 0;
    const goalsForAway  = gf?.total?.away  ?? 0;
    const goalsForTotal = gf?.total?.total ?? 0;

    const goalsAgHome  = ga?.total?.home  ?? 0;
    const goalsAgAway  = ga?.total?.away  ?? 0;
    const goalsAgTotal = ga?.total?.total ?? 0;

    const avgFor     = playedTotal > 0 ? +(goalsForTotal / playedTotal).toFixed(2) : null;
    const avgAgainst = playedTotal > 0 ? +(goalsAgTotal  / playedTotal).toFixed(2) : null;

    await query(`
      INSERT INTO teams_stats (
        team_id, league_id, season,
        form,
        played_home, played_away, played_total,
        wins_home, wins_away, wins_total,
        draws_home, draws_away, draws_total,
        loses_home, loses_away, loses_total,
        goals_for_home, goals_for_away, goals_for_total,
        goals_against_home, goals_against_away, goals_against_total,
        avg_goals_for, avg_goals_against,
        clean_sheets_home, clean_sheets_away, clean_sheets_total,
        updated_at
      ) VALUES (
        $1, $2, $3,
        $4,
        $5, $6, $7,
        $8, $9, $10,
        $11, $12, $13,
        $14, $15, $16,
        $17, $18, $19,
        $20, $21, $22,
        $23, $24,
        $25, $26, $27,
        NOW()
      )
      ON CONFLICT (team_id, league_id, season) DO UPDATE SET
        form               = EXCLUDED.form,
        played_home        = EXCLUDED.played_home,
        played_away        = EXCLUDED.played_away,
        played_total       = EXCLUDED.played_total,
        wins_home          = EXCLUDED.wins_home,
        wins_away          = EXCLUDED.wins_away,
        wins_total         = EXCLUDED.wins_total,
        draws_home         = EXCLUDED.draws_home,
        draws_away         = EXCLUDED.draws_away,
        draws_total        = EXCLUDED.draws_total,
        loses_home         = EXCLUDED.loses_home,
        loses_away         = EXCLUDED.loses_away,
        loses_total        = EXCLUDED.loses_total,
        goals_for_home     = EXCLUDED.goals_for_home,
        goals_for_away     = EXCLUDED.goals_for_away,
        goals_for_total    = EXCLUDED.goals_for_total,
        goals_against_home = EXCLUDED.goals_against_home,
        goals_against_away = EXCLUDED.goals_against_away,
        goals_against_total= EXCLUDED.goals_against_total,
        avg_goals_for      = EXCLUDED.avg_goals_for,
        avg_goals_against  = EXCLUDED.avg_goals_against,
        clean_sheets_home  = EXCLUDED.clean_sheets_home,
        clean_sheets_away  = EXCLUDED.clean_sheets_away,
        clean_sheets_total = EXCLUDED.clean_sheets_total,
        updated_at         = NOW()
    `, [
      teamId, leagueId, season,
      s.form || null,
      playedHome, playedAway, playedTotal,
      fx.wins?.home  ?? 0, fx.wins?.away  ?? 0, fx.wins?.total  ?? 0,
      fx.draws?.home ?? 0, fx.draws?.away ?? 0, fx.draws?.total ?? 0,
      fx.loses?.home ?? 0, fx.loses?.away ?? 0, fx.loses?.total ?? 0,
      goalsForHome, goalsForAway, goalsForTotal,
      goalsAgHome,  goalsAgAway,  goalsAgTotal,
      avgFor, avgAgainst,
      cs?.home  ?? 0, cs?.away  ?? 0, cs?.total ?? 0,
    ]);

    return { team_id: teamId, league_id: leagueId, played: playedTotal, avg_for: avgFor };
  } catch (e) {
    console.warn(`[collect-team-stats] ${teamId}/${leagueId}:`, e.message);
    return null;
  }
}

export default async function handler(req, res) {
  const limit = parseInt(req.query?.limit || String(LIMIT), 10);
  const season = parseInt(req.query?.season || String(CURRENT_SEASON), 10);

  try {
    // Ia perechile (team_id, league_id) din meciuri viitoare / recente
    // care nu au fost actualizate in ultimele 7 zile sau nu exista deloc
    const { rows: pairs } = await query(`
      SELECT DISTINCT f.home_team_id AS team_id, f.league_id
      FROM fixtures f
      WHERE f.fixture_date >= NOW() - INTERVAL '30 days'
        AND f.fixture_date <= NOW() + INTERVAL '7 days'
        AND f.home_team_id IS NOT NULL
        AND f.league_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM teams_stats ts
          WHERE ts.team_id = f.home_team_id
            AND ts.league_id = f.league_id
            AND ts.season = $1
            AND ts.updated_at > NOW() - INTERVAL '7 days'
        )
      UNION
      SELECT DISTINCT f.away_team_id AS team_id, f.league_id
      FROM fixtures f
      WHERE f.fixture_date >= NOW() - INTERVAL '30 days'
        AND f.fixture_date <= NOW() + INTERVAL '7 days'
        AND f.away_team_id IS NOT NULL
        AND f.league_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM teams_stats ts
          WHERE ts.team_id = f.away_team_id
            AND ts.league_id = f.league_id
            AND ts.season = $1
            AND ts.updated_at > NOW() - INTERVAL '7 days'
        )
      ORDER BY team_id
      LIMIT $2
    `, [season, limit]).catch(() => ({ rows: [] }));

    const results = [];
    for (const p of pairs) {
      const out = await collectOne(p.team_id, p.league_id, season);
      if (out) results.push(out);
      await new Promise(r => setTimeout(r, 200));
    }

    await query(`
      INSERT INTO cron_logs (job_name, ran_at, status, fixtures_processed)
      VALUES ('collect-team-stats', NOW(), 'success', $1)
    `, [results.length]).catch(() => {});

    const { rows: total } = await query(
      `SELECT COUNT(*)::int AS n FROM teams_stats WHERE season = $1`, [season]
    ).catch(() => ({ rows: [{ n: 0 }] }));

    return res.status(200).json({
      ok: true,
      season,
      pairs_found: pairs.length,
      upserted: results.length,
      total_in_db: total[0]?.n || 0,
      sample: results.slice(0, 5),
    });
  } catch (e) {
    console.error('[collect-team-stats]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
