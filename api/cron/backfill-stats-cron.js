// Cron wrapper FĂRĂ autentificare pentru backfill match_stats + h2h.
//
// Apelat din crontab de 3 ori/zi (09:00, 14:00, 20:00) pentru a colecta
// progresiv statistici lipsă pe tot istoricul din fixtures_history.
// Spre deosebire de /api/backfill-stats (admin), acest endpoint nu cere ADMIN_KEY
// fiindcă e accesibil doar pe localhost prin crontab.

import { backfillMatchStats, backfillH2H } from '../backfill-stats.js';

const log = (...m) => console.log('[backfill-stats-cron]', ...m);

export default async function handler(req, res) {
  try {
    log('start: match_stats(1000) + h2h(500)');
    const match_stats = await backfillMatchStats(1000);
    const h2h = await backfillH2H(500);
    log(`done: match_stats ok=${match_stats.ok}/${match_stats.total}, h2h ok=${h2h.ok}/${h2h.total}`);
    return res.status(200).json({ ok: true, match_stats, h2h });
  } catch (e) {
    log(`ERROR: ${e.message}`);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
