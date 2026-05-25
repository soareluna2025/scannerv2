// Cron: extinde referee_stats cu metrici suplimentari
// (home_wr, pct_over_3_5_cards, avg_yellow_h1, avg_yellow_h2)
//
// Calculate din match_events agregat:
// - Cards distribution pe halftime
// - Home win rate sub fiecare arbitru
// - Cards markets pct (3.5, 4.5)
//
// Trigger: GET /api/cron/referee-extended
// Cron: 45 4 * * * (zilnic 04:45, dupa referee-stats)

import { query } from '../db.js';

async function ensureColumns() {
  await query(`ALTER TABLE referee_stats ADD COLUMN IF NOT EXISTS home_win_rate NUMERIC(5,2)`).catch(() => {});
  await query(`ALTER TABLE referee_stats ADD COLUMN IF NOT EXISTS away_win_rate NUMERIC(5,2)`).catch(() => {});
  await query(`ALTER TABLE referee_stats ADD COLUMN IF NOT EXISTS draw_rate NUMERIC(5,2)`).catch(() => {});
  await query(`ALTER TABLE referee_stats ADD COLUMN IF NOT EXISTS pct_over_3_5_cards NUMERIC(5,2)`).catch(() => {});
  await query(`ALTER TABLE referee_stats ADD COLUMN IF NOT EXISTS pct_over_4_5_cards NUMERIC(5,2)`).catch(() => {});
  await query(`ALTER TABLE referee_stats ADD COLUMN IF NOT EXISTS avg_yellow_h1 NUMERIC(4,2)`).catch(() => {});
  await query(`ALTER TABLE referee_stats ADD COLUMN IF NOT EXISTS avg_yellow_h2 NUMERIC(4,2)`).catch(() => {});
  await query(`ALTER TABLE referee_stats ADD COLUMN IF NOT EXISTS card_bias_score NUMERIC(4,2)`).catch(() => {});
}

export default async function handler(req, res) {
  const limit = parseInt(req.query?.limit || '50', 10);

  try {
    await ensureColumns();

    // 1. Home/Away/Draw win rates per referee din fixtures_history
    // Doar arbitri neactualizati in ultimele 7 zile (evita loop infinit)
    const { rows: outcomes } = await query(`
      SELECT
        referee AS rname,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE home_goals > away_goals)::int AS home_wins,
        COUNT(*) FILTER (WHERE home_goals < away_goals)::int AS away_wins,
        COUNT(*) FILTER (WHERE home_goals = away_goals)::int AS draws
      FROM fixtures_history
      WHERE referee IS NOT NULL AND referee != ''
        AND status_short IN ('FT','AET','PEN')
        AND home_goals IS NOT NULL
        AND match_date > NOW() - INTERVAL '24 months'
        AND NOT EXISTS (
          SELECT 1 FROM referee_stats rs
          WHERE rs.referee_name = fixtures_history.referee
            AND rs.updated_at > NOW() - INTERVAL '7 days'
        )
      GROUP BY referee
      HAVING COUNT(*) >= 5
      LIMIT $1
    `, [limit]).catch((e) => {
      console.error('[ref-ext] outcomes query:', e.message);
      return { rows: [] };
    });

    // 2. Cards distribution pe halftime din match_events
    const { rows: cardsByRef } = await query(`
      SELECT
        fh.referee AS rname,
        COUNT(DISTINCT fh.fixture_id)::int AS matches,
        SUM(CASE WHEN me.elapsed <= 45 AND me.type = 'Card' AND me.detail = 'Yellow Card' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(DISTINCT fh.fixture_id), 0) AS avg_y_h1,
        SUM(CASE WHEN me.elapsed > 45 AND me.type = 'Card' AND me.detail = 'Yellow Card' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(DISTINCT fh.fixture_id), 0) AS avg_y_h2,
        SUM(CASE WHEN me.type = 'Card' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(DISTINCT fh.fixture_id), 0) AS avg_cards_total
      FROM fixtures_history fh
      JOIN match_events me ON me.fixture_id = fh.fixture_id
      WHERE fh.referee IS NOT NULL AND fh.referee != ''
        AND fh.match_date > NOW() - INTERVAL '24 months'
      GROUP BY fh.referee
      HAVING COUNT(DISTINCT fh.fixture_id) >= 3
    `).catch((e) => {
      console.error('[ref-ext] cards query:', e.message);
      return { rows: [] };
    });

    const cardMap = {};
    cardsByRef.forEach(r => { cardMap[r.rname] = r; });

    // 3. % over 3.5/4.5 cards per referee (din agregare la nivel match)
    const { rows: cardThresh } = await query(`
      WITH match_cards AS (
        SELECT
          fh.fixture_id,
          fh.referee AS rname,
          COUNT(*) FILTER (WHERE me.type = 'Card')::int AS total_cards
        FROM fixtures_history fh
        JOIN match_events me ON me.fixture_id = fh.fixture_id
        WHERE fh.referee IS NOT NULL AND fh.referee != ''
          AND fh.match_date > NOW() - INTERVAL '24 months'
        GROUP BY fh.fixture_id, fh.referee
      )
      SELECT
        rname,
        COUNT(*) FILTER (WHERE total_cards > 3)::float / COUNT(*)::float * 100 AS pct_over_3_5,
        COUNT(*) FILTER (WHERE total_cards > 4)::float / COUNT(*)::float * 100 AS pct_over_4_5
      FROM match_cards
      GROUP BY rname
      HAVING COUNT(*) >= 3
    `).catch(() => ({ rows: [] }));

    const threshMap = {};
    cardThresh.forEach(r => { threshMap[r.rname] = r; });

    // UPDATE referee_stats cu metrici noi
    let upserts = 0;
    for (const o of outcomes) {
      const total = Number(o.total);
      const homeWr = +(Number(o.home_wins) / total * 100).toFixed(2);
      const awayWr = +(Number(o.away_wins) / total * 100).toFixed(2);
      const drawWr = +(Number(o.draws) / total * 100).toFixed(2);
      const cm = cardMap[o.rname] || {};
      const th = threshMap[o.rname] || {};
      const avgYH1 = cm.avg_y_h1 ? +Number(cm.avg_y_h1).toFixed(2) : null;
      const avgYH2 = cm.avg_y_h2 ? +Number(cm.avg_y_h2).toFixed(2) : null;
      const pctO35 = th.pct_over_3_5 ? +Number(th.pct_over_3_5).toFixed(2) : null;
      const pctO45 = th.pct_over_4_5 ? +Number(th.pct_over_4_5).toFixed(2) : null;
      // Bias score: cat de mult home castigi cu acest arbitru (relativ la baseline 45% global)
      const biasScore = +(homeWr - 45).toFixed(2);

      await query(`
        INSERT INTO referee_stats (referee_name, total_matches, home_win_rate, away_win_rate, draw_rate, pct_over_3_5_cards, pct_over_4_5_cards, avg_yellow_h1, avg_yellow_h2, card_bias_score, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        ON CONFLICT (referee_name) DO UPDATE SET
          total_matches = GREATEST(referee_stats.total_matches, EXCLUDED.total_matches),
          home_win_rate = EXCLUDED.home_win_rate,
          away_win_rate = EXCLUDED.away_win_rate,
          draw_rate = EXCLUDED.draw_rate,
          pct_over_3_5_cards = EXCLUDED.pct_over_3_5_cards,
          pct_over_4_5_cards = EXCLUDED.pct_over_4_5_cards,
          avg_yellow_h1 = EXCLUDED.avg_yellow_h1,
          avg_yellow_h2 = EXCLUDED.avg_yellow_h2,
          card_bias_score = EXCLUDED.card_bias_score,
          updated_at = NOW()
      `, [o.rname, total, homeWr, awayWr, drawWr, pctO35, pctO45, avgYH1, avgYH2, biasScore]).catch(() => {});
      upserts++;
    }

    await query(`
      INSERT INTO cron_logs (job_name, ran_at, status, fixtures_processed)
      VALUES ('referee-extended', NOW(), 'success', $1)
    `, [upserts]).catch(() => {});

    const { rows: rem } = await query(`
      SELECT COUNT(DISTINCT referee)::int AS n
      FROM fixtures_history
      WHERE referee IS NOT NULL AND referee != ''
        AND status_short IN ('FT','AET','PEN')
        AND home_goals IS NOT NULL
        AND match_date > NOW() - INTERVAL '24 months'
        AND NOT EXISTS (
          SELECT 1 FROM referee_stats rs
          WHERE rs.referee_name = fixtures_history.referee
            AND rs.updated_at > NOW() - INTERVAL '7 days'
        )
      HAVING COUNT(*) >= 5
    `).catch(() => ({ rows: [{ n: 0 }] }));

    return res.status(200).json({
      ok: true,
      referees_updated: upserts,
      remaining: rem[0]?.n ?? 0,
      sample: outcomes.slice(0, 5).map(o => ({
        ref: o.rname,
        total: Number(o.total),
        home_wr: +(Number(o.home_wins) / Number(o.total) * 100).toFixed(1),
      })),
    });
  } catch (e) {
    console.error('[referee-extended]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
