// Cron: GET /api/update-results
// Fetches pending predictions (no result yet) and fills in real match outcomes.

import { query } from './db.js';

export default async function handler(req, res) {
  const afKey = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;

  if (!afKey) return res.status(500).json({ error: 'API_FOOTBALL_KEY not configured' });

  try {
    // Select predictions without results where match_date has passed
    const pendingRes = await query(
      `SELECT id, fixture_id FROM predictions
       WHERE result_over15 IS NULL AND match_date < NOW()
       LIMIT 100`
    );

    const pending = pendingRes.rows;
    if (!pending.length) {
      return res.status(200).json({ updated: 0, total: 0 });
    }

    let updated = 0;
    const hdr = { 'x-apisports-key': afKey };

    for (const pred of pending) {
      try {
        const fr  = await fetch(`https://v3.football.api-sports.io/fixtures?id=${pred.fixture_id}`, { headers: hdr });
        const fd  = await fr.json();
        const fix = fd.response?.[0];
        if (!fix) continue;

        const status = fix.fixture?.status?.short;
        if (!['FT', 'AET', 'PEN'].includes(status)) continue;

        const hg = fix.goals?.home;
        const ag = fix.goals?.away;
        if (hg == null || ag == null) continue;

        const pr = await query(
          `UPDATE predictions SET
             result_over15 = $1,
             result_gg     = $2,
             updated_at    = NOW()
           WHERE fixture_id = $3`,
          [(hg + ag) >= 2, hg > 0 && ag > 0, pred.fixture_id]
        );
        if (pr.rowCount > 0) {
          updated++;
          // Update pre_match_snapshots outcome for back-testing accuracy tracking
          query(
            `UPDATE pre_match_snapshots
             SET outcome = CASE
               WHEN over15_prob >= 55 AND $1 THEN 'WIN'
               WHEN over15_prob < 45  AND NOT $1 THEN 'WIN'
               ELSE 'LOSS'
             END
             WHERE fixture_id = $2 AND outcome IS NULL`,
            [(hg + ag) >= 2, pred.fixture_id]
          ).catch(() => {});
        }
      } catch (_) { /* skip fixture, try next */ }
    }

    return res.status(200).json({ updated, total: pending.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
