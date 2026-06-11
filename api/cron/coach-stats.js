// Cron: agregare stats per antrenor din fixtures_history
// Calculeaza per coach:
// - matches_played, wins, draws, losses
// - win_rate
// - avg_goals_for, avg_goals_against
// - clean_sheet_rate
// - tenure_days (la echipa curenta)
// - style_indicator: offensive/balanced/defensive
//
// Note: relationship coach <-> match nu e direct in fixtures_history.
// Trebuie sa derivam din coach_career: pentru fiecare meci, coach-ul a fost
// cel cu start_date <= match_date AND (end_date IS NULL OR end_date >= match_date)
//
// Trigger: GET /api/cron/coach-stats
// Cron: 30 5 * * 1 (luni 05:30, dupa collect-coaches)

import { query } from '../db.js';

async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS coach_stats (
      coach_id           INT PRIMARY KEY,
      coach_name         TEXT,
      matches            INT DEFAULT 0,
      wins               INT DEFAULT 0,
      draws              INT DEFAULT 0,
      losses             INT DEFAULT 0,
      win_rate           NUMERIC(5,2),
      avg_goals_for      NUMERIC(4,2),
      avg_goals_against  NUMERIC(4,2),
      clean_sheet_rate   NUMERIC(5,2),
      failed_to_score_rate NUMERIC(5,2),
      style              TEXT,
      tenure_days        INT,
      current_team_id    INT,
      last_match_date    TIMESTAMPTZ,
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
}

export default async function handler(req, res) {
  try {
    await ensureTable();

    // Agregare per coach pe ultimele 24 luni
    // Folosim coach_career pentru a mapa coach -> meciuri
    const { rows: agg } = await query(`
      WITH coach_matches AS (
        SELECT
          c.coach_id,
          c.team_name,
          c.team_id,
          fh.fixture_id,
          fh.match_date,
          fh.home_goals,
          fh.away_goals,
          fh.home_team_id,
          fh.away_team_id,
          CASE WHEN fh.home_team_id = c.team_id THEN fh.home_goals ELSE fh.away_goals END AS team_goals,
          CASE WHEN fh.home_team_id = c.team_id THEN fh.away_goals ELSE fh.home_goals END AS opp_goals,
          CASE
            WHEN fh.home_team_id = c.team_id AND fh.home_goals > fh.away_goals THEN 'W'
            WHEN fh.away_team_id = c.team_id AND fh.away_goals > fh.home_goals THEN 'W'
            WHEN fh.home_goals = fh.away_goals THEN 'D'
            ELSE 'L'
          END AS result
        FROM coach_career c
        JOIN fixtures_history fh ON (fh.home_team_id = c.team_id OR fh.away_team_id = c.team_id)
        WHERE fh.match_date > NOW() - INTERVAL '24 months'
          AND fh.status_short IN ('FT', 'AET', 'PEN')
          AND fh.home_goals IS NOT NULL
          AND c.start_date <= fh.match_date::date
          AND (c.end_date IS NULL OR c.end_date >= fh.match_date::date)
      )
      SELECT
        cm.coach_id,
        MAX(co.name) AS coach_name,
        COUNT(*)::int AS matches,
        COUNT(*) FILTER (WHERE cm.result = 'W')::int AS wins,
        COUNT(*) FILTER (WHERE cm.result = 'D')::int AS draws,
        COUNT(*) FILTER (WHERE cm.result = 'L')::int AS losses,
        AVG(cm.team_goals)::numeric(4,2) AS avg_for,
        AVG(cm.opp_goals)::numeric(4,2) AS avg_against,
        COUNT(*) FILTER (WHERE cm.opp_goals = 0)::float / NULLIF(COUNT(*), 0) * 100 AS clean_sheet_rate,
        COUNT(*) FILTER (WHERE cm.team_goals = 0)::float / NULLIF(COUNT(*), 0) * 100 AS failed_score_rate,
        MAX(cm.match_date) AS last_match,
        (array_agg(cm.team_id ORDER BY cm.match_date DESC))[1] AS current_team
      FROM coach_matches cm
      LEFT JOIN coaches co ON co.coach_id = cm.coach_id
      GROUP BY cm.coach_id
      HAVING COUNT(*) >= 5
    `).catch((e) => {
      console.error('[coach-stats] query failed:', e.message);
      return { rows: [] };
    });

    let upserts = 0;
    for (const r of agg) {
      const matches = Number(r.matches);
      const wins = Number(r.wins);
      const wr = matches > 0 ? +(wins / matches * 100).toFixed(2) : null;
      const avgFor = Number(r.avg_for);
      const avgAgainst = Number(r.avg_against);
      const csRate = r.clean_sheet_rate ? +Number(r.clean_sheet_rate).toFixed(2) : null;
      const fsRate = r.failed_score_rate ? +Number(r.failed_score_rate).toFixed(2) : null;

      // Style indicator
      let style = 'balanced';
      if (avgFor > 1.8 && avgAgainst > 1.3) style = 'open';
      else if (avgFor > 1.6) style = 'offensive';
      else if (avgAgainst < 1.0 && csRate > 35) style = 'defensive';
      else if (avgFor < 1.2) style = 'pragmatic';

      // Tenure: zile de la prima aparitie la echipa curenta in coach_career
      const { rows: tenureRow } = await query(`
        SELECT EXTRACT(DAY FROM NOW() - MIN(start_date)) AS days
        FROM coach_career
        WHERE coach_id = $1 AND team_id = $2 AND end_date IS NULL
      `, [r.coach_id, r.current_team]).catch(() => ({ rows: [{ days: null }] }));
      const tenureDays = tenureRow[0]?.days ? Number(tenureRow[0].days) : null;

      await query(`
        INSERT INTO coach_stats (coach_id, coach_name, matches, wins, draws, losses, win_rate, avg_goals_for, avg_goals_against, clean_sheet_rate, failed_to_score_rate, style, tenure_days, current_team_id, last_match_date, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
        ON CONFLICT (coach_id) DO UPDATE SET
          coach_name = EXCLUDED.coach_name,
          matches = EXCLUDED.matches,
          wins = EXCLUDED.wins,
          draws = EXCLUDED.draws,
          losses = EXCLUDED.losses,
          win_rate = EXCLUDED.win_rate,
          avg_goals_for = EXCLUDED.avg_goals_for,
          avg_goals_against = EXCLUDED.avg_goals_against,
          clean_sheet_rate = EXCLUDED.clean_sheet_rate,
          failed_to_score_rate = EXCLUDED.failed_to_score_rate,
          style = EXCLUDED.style,
          tenure_days = EXCLUDED.tenure_days,
          current_team_id = EXCLUDED.current_team_id,
          last_match_date = EXCLUDED.last_match_date,
          updated_at = NOW()
      `, [
        r.coach_id, r.coach_name, matches, wins, Number(r.draws), Number(r.losses),
        wr, avgFor, avgAgainst, csRate, fsRate, style, tenureDays, r.current_team, r.last_match,
      ]).catch(e => console.warn('[coach-stats] upsert:', e.message));
      upserts++;
    }

    await Promise.resolve(/* cron_logs → dispecer */).catch(() => {});

    return res.status(200).json({
      ok: true,
      coaches_aggregated: upserts,
      sample: agg.slice(0, 5).map(r => ({
        coach: r.coach_name,
        matches: Number(r.matches),
        wr: r.matches > 0 ? +(Number(r.wins)/Number(r.matches)*100).toFixed(1) : null,
        avg_for: Number(r.avg_for),
        avg_against: Number(r.avg_against),
      })),
    });
  } catch (e) {
    console.error('[coach-stats]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
