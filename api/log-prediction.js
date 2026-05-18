// Helper: insert into prediction_log (fire-and-forget safe)
import { query } from './db.js';

export async function logPrediction(p) {
  try {
    await query(
      `INSERT INTO prediction_log
         (fixture_id, league_id, league_name, home_team, away_team, match_date,
          minute, score_at_prediction, venue_surface, referee_name,
          module, predicted_value, threshold_used,
          lambda_home, lambda_away, ngp_value,
          layer1_score, layer2_score, layer3_score, layer4_score,
          layer5_score, layer6_score, layer7_score,
          injuries_home, injuries_away, outcome)
       VALUES
         ($1,$2,$3,$4,$5,$6,
          $7,$8,$9,$10,
          $11,$12,$13,
          $14,$15,$16,
          $17,$18,$19,$20,
          $21,$22,$23,
          $24,$25,'PENDING')`,
      [
        p.fixture_id   ?? null, p.league_id    ?? null, p.league_name  ?? null,
        p.home_team    ?? null, p.away_team    ?? null, p.match_date   ?? null,
        p.minute       ?? null, p.score        ?? null, p.venue_surface?? null,
        p.referee      ?? null,
        p.module, p.predicted_value ?? null, p.threshold_used ?? null,
        p.lambda_home  ?? null, p.lambda_away  ?? null, p.ngp_value    ?? null,
        p.layer1       ?? null, p.layer2       ?? null, p.layer3       ?? null,
        p.layer4       ?? null, p.layer5       ?? null, p.layer6       ?? null,
        p.layer7       ?? null,
        p.injuries_home ?? 0,  p.injuries_away ?? 0,
      ]
    );
  } catch (_) { /* non-critical */ }
}
