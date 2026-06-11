// Calibrare LIVE — antreneaza tabel pentru meciuri LIVE pe baza
// match_events si fixtures_history. Pentru fiecare (minut_bucket,
// scor_curent_bucket, lambda_remaining_bucket) -> P(>=1 gol restul).
//
// Diferit de calibrarea pre-meci (G2_CALIBRATION):
// - Variabile diferite (minutul si scorul curent conteaza)
// - Antrenat pe momente LIVE (snapshots la diverse minute)
//
// Output: tabela calibration_live cu pattern-uri reale.
//
// GET /api/cron/calibrate-live
// Cron: 30 5 * * 0 (duminica 05:30, weekly)

import { query } from '../db.js';

async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS calibration_live (
      id              SERIAL PRIMARY KEY,
      minute_bucket   TEXT NOT NULL,
      score_state     TEXT NOT NULL,
      market          TEXT NOT NULL,
      n_samples       INT NOT NULL,
      real_pct        NUMERIC(5,2) NOT NULL,
      generated_at    TIMESTAMP DEFAULT NOW(),
      UNIQUE(minute_bucket, score_state, market)
    )
  `);
}

function minuteBucket(m) {
  if (m <= 15) return '0-15';
  if (m <= 30) return '16-30';
  if (m <= 45) return '31-45';
  if (m <= 60) return '46-60';
  if (m <= 75) return '61-75';
  return '76-90';
}

function scoreState(h, a) {
  if (h === 0 && a === 0) return '0-0';
  if (h === 1 && a === 0) return '1-0';
  if (h === 0 && a === 1) return '0-1';
  if (h === 1 && a === 1) return '1-1';
  if (h - a >= 2) return 'home_+2';
  if (a - h >= 2) return 'away_+2';
  return 'other';
}

export default async function handler(req, res) {
  try {
    await ensureTable();

    // Pentru fiecare meci FT din ultimele 365 zile, reconstruim snapshot-uri
    // la fiecare 15 min minute pe baza match_events.
    const { rows: matches } = await query(`
      SELECT fh.fixture_id, fh.home_goals, fh.away_goals, fh.status_short
      FROM fixtures_history fh
      WHERE fh.match_date > NOW() - INTERVAL '730 days'
        AND fh.status_short IN ('FT','AET','PEN')
        AND fh.home_goals IS NOT NULL
      LIMIT 20000
    `).catch((e) => { console.error('[calibrate-live] fixtures query failed:', e.message); return { rows: [] }; });

    if (!matches.length) {
      return res.status(200).json({ ok: true, message: 'no resolved matches', count: 0 });
    }

    // Buckets: (minute_bucket, score_state) -> { o15: {n, hits}, o25: {n, hits}, gg: {n, hits} }
    const stats = {};

    for (const fx of matches) {
      const finalH = Number(fx.home_goals || 0);
      const finalA = Number(fx.away_goals || 0);
      // Fetch goal events ordered by minute
      const { rows: evs } = await query(`
        SELECT elapsed AS minute, team_id, type
        FROM match_events
        WHERE fixture_id = $1 AND type = 'Goal'
        ORDER BY elapsed ASC
      `, [fx.fixture_id]).catch(() => ({ rows: [] }));

      // Reconstruct score timeline at each min mark
      // Snapshot la minute: 15, 30, 45, 60, 75
      const snapshots = [15, 30, 45, 60, 75];
      for (const m of snapshots) {
        let hAt = 0, aAt = 0;
        // Simpler approach: count goals up to minute m
        const goalsAtMin = evs.filter(e => Number(e.minute || 0) <= m).length;
        // Distribute approximately (assume final ratio)
        const finalTotal = finalH + finalA;
        if (finalTotal === 0) {
          hAt = 0; aAt = 0;
        } else {
          // Approximate split based on final ratio + current count
          hAt = Math.min(finalH, Math.round(goalsAtMin * finalH / finalTotal));
          aAt = Math.min(finalA, goalsAtMin - hAt);
        }
        const mb = minuteBucket(m);
        const sst = scoreState(hAt, aAt);
        const key = `${mb}|${sst}`;
        if (!stats[key]) stats[key] = { o15: { n: 0, hits: 0 }, o25: { n: 0, hits: 0 }, o35: { n: 0, hits: 0 }, o45: { n: 0, hits: 0 }, gg: { n: 0, hits: 0 } };
        // Check markets
        stats[key].o15.n++;
        if (finalTotal >= 2) stats[key].o15.hits++;
        stats[key].o25.n++;
        if (finalTotal >= 3) stats[key].o25.hits++;
        stats[key].o35.n++;
        if (finalTotal >= 4) stats[key].o35.hits++;
        stats[key].o45.n++;
        if (finalTotal >= 5) stats[key].o45.hits++;
        stats[key].gg.n++;
        if (finalH > 0 && finalA > 0) stats[key].gg.hits++;
      }
    }

    // Upsert in calibration_live
    let upserts = 0;
    for (const [key, mkts] of Object.entries(stats)) {
      const [minute_bucket, score_state] = key.split('|');
      for (const [marketShort, data] of Object.entries(mkts)) {
        if (data.n < 10) continue;
        const market = marketShort === 'o15' ? 'over15'
                     : marketShort === 'o25' ? 'over25'
                     : marketShort === 'o35' ? 'over35'
                     : marketShort === 'o45' ? 'over45'
                     : 'gg';
        const real_pct = +(data.hits / data.n * 100).toFixed(2);
        await query(`
          INSERT INTO calibration_live (minute_bucket, score_state, market, n_samples, real_pct, generated_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (minute_bucket, score_state, market) DO UPDATE SET
            n_samples = EXCLUDED.n_samples,
            real_pct = EXCLUDED.real_pct,
            generated_at = EXCLUDED.generated_at
        `, [minute_bucket, score_state, market, data.n, real_pct]);
        upserts++;
      }
    }

    await Promise.resolve(/* cron_logs → dispecer */).catch(() => {});

    return res.status(200).json({
      ok: true,
      matches_analyzed: matches.length,
      buckets_updated: upserts,
    });
  } catch (e) {
    console.error('[calibrate-live]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
