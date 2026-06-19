// api/utils/goal-timing-sql.js
// SURSĂ CANONICĂ UNICĂ pentru features de „timing goluri" (anti train/serve skew).
// Aceeași expresie SQL e folosită de:
//   • api/cron/build-ml-features.js  (→ ml_features → ANTRENAMENT train_model.py)
//   • api/enrich.js                  (→ result.*  → SERVING ml-predict.js)
// Astfel 2a și 2b sunt IDENTICE prin construcție (regula de aur). NU duplica logica
// — orice schimbare se face DOAR aici.
//
// Definiții IDENTICE cu ml/experiment_goaltiming.py:
//   • fereastră = ultimele 20 meciuri ANTERIOARE ale echipei (match_date STRICT <), <5 → NULL
//   • R2 = elapsed > 45 ; „târziu" = elapsed >= 75 ; r1 = total scored − r2 (per meci)
//   • atribuire goluri pe team_id (ca build-ml-features; own-goals NEcorectate)
//   • marcate vs încasate: încasate = golurile adversarului din aceleași meciuri
//
// teamExpr/dateExpr = referințe SQL: în LATERAL = coloane outer ('fh.home_team_id',
// 'fh.match_date'); standalone (enrich) = '$1' / '$2'. Întoarce un SELECT cu 6 coloane:
//   tm_scored_r2_share, tm_conceded_r2_share, tm_scored_late_share,
//   tm_conceded_late_share, tm_scored_r1_rate, tm_scored_r2_rate

export function timingBody(teamExpr, dateExpr) {
  return `
SELECT
  CASE WHEN pc.n < 5 THEN NULL WHEN gc.sg > 0 THEN gc.sg_r2::float / gc.sg ELSE 0 END   AS tm_scored_r2_share,
  CASE WHEN pc.n < 5 THEN NULL WHEN gc.cg > 0 THEN gc.cg_r2::float / gc.cg ELSE 0 END   AS tm_conceded_r2_share,
  CASE WHEN pc.n < 5 THEN NULL WHEN gc.sg > 0 THEN gc.sg_late::float / gc.sg ELSE 0 END AS tm_scored_late_share,
  CASE WHEN pc.n < 5 THEN NULL WHEN gc.cg > 0 THEN gc.cg_late::float / gc.cg ELSE 0 END AS tm_conceded_late_share,
  CASE WHEN pc.n < 5 THEN NULL ELSE (gc.sg - gc.sg_r2)::float / pc.n END                AS tm_scored_r1_rate,
  CASE WHEN pc.n < 5 THEN NULL ELSE gc.sg_r2::float / pc.n END                          AS tm_scored_r2_rate
FROM
  (SELECT COUNT(*) AS n FROM (
      SELECT fhx.fixture_id FROM fixtures_history fhx
       WHERE (fhx.home_team_id = ${teamExpr} OR fhx.away_team_id = ${teamExpr})
         AND fhx.match_date < ${dateExpr}
       ORDER BY fhx.match_date DESC LIMIT 20) pp) pc,
  (SELECT
      COALESCE(SUM(CASE WHEN me.team_id = ${teamExpr} THEN 1 ELSE 0 END), 0)                      AS sg,
      COALESCE(SUM(CASE WHEN me.team_id = ${teamExpr} AND me.elapsed > 45 THEN 1 ELSE 0 END), 0)  AS sg_r2,
      COALESCE(SUM(CASE WHEN me.team_id = ${teamExpr} AND me.elapsed >= 75 THEN 1 ELSE 0 END), 0) AS sg_late,
      COALESCE(SUM(CASE WHEN me.team_id = pr.opp THEN 1 ELSE 0 END), 0)                           AS cg,
      COALESCE(SUM(CASE WHEN me.team_id = pr.opp AND me.elapsed > 45 THEN 1 ELSE 0 END), 0)       AS cg_r2,
      COALESCE(SUM(CASE WHEN me.team_id = pr.opp AND me.elapsed >= 75 THEN 1 ELSE 0 END), 0)      AS cg_late
   FROM (
      SELECT fhx.fixture_id,
             CASE WHEN fhx.home_team_id = ${teamExpr} THEN fhx.away_team_id ELSE fhx.home_team_id END AS opp
        FROM fixtures_history fhx
       WHERE (fhx.home_team_id = ${teamExpr} OR fhx.away_team_id = ${teamExpr})
         AND fhx.match_date < ${dateExpr}
       ORDER BY fhx.match_date DESC LIMIT 20) pr
   JOIN match_events me ON me.fixture_id = pr.fixture_id AND me.type = 'Goal' AND me.elapsed IS NOT NULL
  ) gc`;
}

// Numele celor 12 coloane (home_/away_) — folosite în ml_features, train_model,
// build-ml-features, enrich, ml-predict. Sursă unică ca să nu divergă.
export const TIMING_BASE = [
  "tm_scored_r2_share", "tm_conceded_r2_share", "tm_scored_late_share",
  "tm_conceded_late_share", "tm_scored_r1_rate", "tm_scored_r2_rate",
];
export const TIMING_COLUMNS = [
  ...TIMING_BASE.map(b => `home_${b}`),
  ...TIMING_BASE.map(b => `away_${b}`),
];
