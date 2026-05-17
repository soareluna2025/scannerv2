import { query } from './db.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { rows } = await query(`
      SELECT
        league_id, league_name,
        calibration_factor_over15, calibration_factor_over25, calibration_factor_gg,
        total_matches, correct_over15, correct_over25, correct_gg,
        accuracy_over15, accuracy_over25, accuracy_gg,
        avg_predicted_over15, avg_predicted_over25, avg_predicted_gg,
        last_updated
      FROM prediction_calibration
      WHERE total_matches >= 10
      ORDER BY total_matches DESC
      LIMIT 100
    `).catch(() => ({ rows: [] }));

    const totM  = rows.reduce((s, r) => s + (Number(r.total_matches)  || 0), 0);
    const tot15 = rows.reduce((s, r) => s + (Number(r.correct_over15) || 0), 0);
    const tot25 = rows.reduce((s, r) => s + (Number(r.correct_over25) || 0), 0);
    const totGG = rows.reduce((s, r) => s + (Number(r.correct_gg)     || 0), 0);

    res.status(200).json({
      ok: true,
      total_leagues: rows.length,
      overall: {
        total_matches:   totM,
        accuracy_over15: totM > 0 ? parseFloat((tot15 / totM * 100).toFixed(1)) : null,
        accuracy_over25: totM > 0 ? parseFloat((tot25 / totM * 100).toFixed(1)) : null,
        accuracy_gg:     totM > 0 ? parseFloat((totGG / totM * 100).toFixed(1)) : null,
      },
      leagues: rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
