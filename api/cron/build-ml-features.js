// api/cron/build-ml-features.js — feature store ML (materializare).
// GET /api/cron/build-ml-features
//
// Calculează mediile ISTORICE (rolling 100, point-in-time, fără lookahead) și le
// scrie în tabela ml_features. Sursa de adevăr a SQL-ului de mai jos = LATERAL-urile
// (msh/msa/meh/mea) din ml/train_model.py — TREBUIE să rămână IDENTICE (orice
// modificare se face în AMBELE locuri).
//
// Batch BATCH_SIZE fixture_id / rulare, idempotent (ON CONFLICT DO NOTHING),
// reluabil (procesează DOAR fixturile din predictions încă nematerializate).
import { query } from '../db.js';
import { timingBody } from '../utils/goal-timing-sql.js';

const BATCH_SIZE = 5000;

function log(msg) {
  console.log(`[cron/build-ml-features] ${new Date().toISOString()} ${msg}`);
}

// ⚠ CANONIC: aceleași 4 LATERAL ca ml/train_model.py (msh/msa/meh/mea).
const INSERT_SQL = `
INSERT INTO ml_features (
  fixture_id,
  home_sot_avg, away_sot_avg,
  home_corners_avg, away_corners_avg,
  home_xg_avg, away_xg_avg,
  home_yc_avg, away_yc_avg,
  home_rc_avg, away_rc_avg,
  home_fouls_avg, away_fouls_avg,
  home_insidebox_avg, away_insidebox_avg,
  home_possession_avg, away_possession_avg,
  home_goals_r1_avg, away_goals_r1_avg,
  home_goals_r2_avg, away_goals_r2_avg,
  home_subs_avg, away_subs_avg,
  home_tm_scored_r2_share, away_tm_scored_r2_share,
  home_tm_conceded_r2_share, away_tm_conceded_r2_share,
  home_tm_scored_late_share, away_tm_scored_late_share,
  home_tm_conceded_late_share, away_tm_conceded_late_share,
  home_tm_scored_r1_rate, away_tm_scored_r1_rate,
  home_tm_scored_r2_rate, away_tm_scored_r2_rate
)
SELECT
  p.fixture_id,
  msh.sot_avg, msa.sot_avg,
  msh.corners_avg, msa.corners_avg,
  msh.xg_avg, msa.xg_avg,
  msh.yc_avg, msa.yc_avg,
  msh.rc_avg, msa.rc_avg,
  msh.fouls_avg, msa.fouls_avg,
  msh.insidebox_avg, msa.insidebox_avg,
  msh.possession_avg, msa.possession_avg,
  meh.goals_r1_avg, mea.goals_r1_avg,
  meh.goals_r2_avg, mea.goals_r2_avg,
  meh.subs_avg, mea.subs_avg,
  tmh.tm_scored_r2_share, tma.tm_scored_r2_share,
  tmh.tm_conceded_r2_share, tma.tm_conceded_r2_share,
  tmh.tm_scored_late_share, tma.tm_scored_late_share,
  tmh.tm_conceded_late_share, tma.tm_conceded_late_share,
  tmh.tm_scored_r1_rate, tma.tm_scored_r1_rate,
  tmh.tm_scored_r2_rate, tma.tm_scored_r2_rate
FROM (
  SELECT pp.fixture_id, pp.created_at
    FROM predictions pp
   WHERE NOT EXISTS (SELECT 1 FROM ml_features mf WHERE mf.fixture_id = pp.fixture_id)
   ORDER BY pp.created_at ASC
   LIMIT $1
) p
JOIN fixtures_history fh ON fh.fixture_id = p.fixture_id
-- Medii istorice GAZDE (ultimele 100 meciuri cu match_date < meciul curent)
LEFT JOIN LATERAL (
    SELECT AVG(ms.shots_on_goal) AS sot_avg, AVG(ms.corner_kicks) AS corners_avg,
           AVG(ms.expected_goals) AS xg_avg, AVG(ms.yellow_cards) AS yc_avg,
           AVG(ms.red_cards) AS rc_avg, AVG(ms.fouls) AS fouls_avg,
           AVG(ms.shots_insidebox) AS insidebox_avg, AVG(ms.ball_possession) AS possession_avg
    FROM (
        SELECT ms.* FROM match_stats ms
        JOIN fixtures_history fhx ON fhx.fixture_id = ms.fixture_id
        WHERE ms.team_id = fh.home_team_id AND fhx.match_date < fh.match_date
        ORDER BY fhx.match_date DESC LIMIT 100
    ) ms
) msh ON true
-- Medii istorice OASPEȚI
LEFT JOIN LATERAL (
    SELECT AVG(ms.shots_on_goal) AS sot_avg, AVG(ms.corner_kicks) AS corners_avg,
           AVG(ms.expected_goals) AS xg_avg, AVG(ms.yellow_cards) AS yc_avg,
           AVG(ms.red_cards) AS rc_avg, AVG(ms.fouls) AS fouls_avg,
           AVG(ms.shots_insidebox) AS insidebox_avg, AVG(ms.ball_possession) AS possession_avg
    FROM (
        SELECT ms.* FROM match_stats ms
        JOIN fixtures_history fhx ON fhx.fixture_id = ms.fixture_id
        WHERE ms.team_id = fh.away_team_id AND fhx.match_date < fh.match_date
        ORDER BY fhx.match_date DESC LIMIT 100
    ) ms
) msa ON true
-- Medii istorice GOLURI R1/R2 + substituiri (match_events, rolling 100, fără lookahead)
LEFT JOIN LATERAL (
    SELECT
        AVG(CASE WHEN g.r1_goals IS NOT NULL THEN g.r1_goals ELSE 0 END) AS goals_r1_avg,
        AVG(CASE WHEN g.r2_goals IS NOT NULL THEN g.r2_goals ELSE 0 END) AS goals_r2_avg,
        AVG(g.subs) AS subs_avg
    FROM (
        SELECT fhx.fixture_id,
            SUM(CASE WHEN me.type='Goal' AND me.elapsed<=45 AND me.team_id=fh.home_team_id THEN 1 ELSE 0 END) AS r1_goals,
            SUM(CASE WHEN me.type='Goal' AND me.elapsed>45 AND me.team_id=fh.home_team_id THEN 1 ELSE 0 END) AS r2_goals,
            SUM(CASE WHEN me.type='subst' AND me.team_id=fh.home_team_id THEN 1 ELSE 0 END) AS subs
        FROM fixtures_history fhx
        JOIN match_events me ON me.fixture_id=fhx.fixture_id
        WHERE (fhx.home_team_id=fh.home_team_id OR fhx.away_team_id=fh.home_team_id)
        AND fhx.match_date < fh.match_date
        GROUP BY fhx.fixture_id
        ORDER BY MAX(fhx.match_date) DESC LIMIT 100
    ) g
) meh ON true
LEFT JOIN LATERAL (
    SELECT
        AVG(CASE WHEN g.r1_goals IS NOT NULL THEN g.r1_goals ELSE 0 END) AS goals_r1_avg,
        AVG(CASE WHEN g.r2_goals IS NOT NULL THEN g.r2_goals ELSE 0 END) AS goals_r2_avg,
        AVG(g.subs) AS subs_avg
    FROM (
        SELECT fhx.fixture_id,
            SUM(CASE WHEN me.type='Goal' AND me.elapsed<=45 AND me.team_id=fh.away_team_id THEN 1 ELSE 0 END) AS r1_goals,
            SUM(CASE WHEN me.type='Goal' AND me.elapsed>45 AND me.team_id=fh.away_team_id THEN 1 ELSE 0 END) AS r2_goals,
            SUM(CASE WHEN me.type='subst' AND me.team_id=fh.away_team_id THEN 1 ELSE 0 END) AS subs
        FROM fixtures_history fhx
        JOIN match_events me ON me.fixture_id=fhx.fixture_id
        WHERE (fhx.home_team_id=fh.away_team_id OR fhx.away_team_id=fh.away_team_id)
        AND fhx.match_date < fh.match_date
        GROUP BY fhx.fixture_id
        ORDER BY MAX(fhx.match_date) DESC LIMIT 100
    ) g
) mea ON true
-- Timing goluri (rolling 20, point-in-time) — sursă canonică api/utils/goal-timing-sql.js
LEFT JOIN LATERAL (${timingBody('fh.home_team_id', 'fh.match_date')}) tmh ON true
LEFT JOIN LATERAL (${timingBody('fh.away_team_id', 'fh.match_date')}) tma ON true
ON CONFLICT (fixture_id) DO NOTHING
`;

export default async function handler(req, res) {
  const t0 = Date.now();
  try {
    const ins = await query(INSERT_SQL, [BATCH_SIZE]);
    const inserted = ins.rowCount || 0;

    // Câte mai rămân de procesat (predicții fără ml_features, dar prezente în
    // fixtures_history = procesabile).
    const rem = await query(
      `SELECT COUNT(*)::int AS n FROM predictions p
        WHERE NOT EXISTS (SELECT 1 FROM ml_features mf WHERE mf.fixture_id = p.fixture_id)
          AND EXISTS (SELECT 1 FROM fixtures_history fh WHERE fh.fixture_id = p.fixture_id)`
    );
    const remaining = rem.rows[0]?.n ?? 0;
    const durMs = Date.now() - t0;

    log(`inserted=${inserted} remaining=${remaining} (${durMs}ms)`);
    await Promise.resolve(/* cron_logs → dispecer */).catch(() => {});

    res.status(200).json({ ok: true, inserted, remaining, batch_size: BATCH_SIZE, duration_ms: durMs });
  } catch (e) {
    log(`error: ${e.message}`);
    await Promise.resolve(/* cron_logs → dispecer */).catch(() => {});
    res.status(500).json({ ok: false, error: e.message });
  }
}
