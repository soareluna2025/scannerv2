// api/cron/train-live.js — rulează ml/train_live_v2.py (antrenare ML LIVE v2).
// POST/GET /api/cron/train-live
//
// Același mecanism ca api/cron/train-model.js: spawn `bash -c` care sursează
// .env (set -a && . .env && set +a) și rulează `python3 -u ml/train_live_v2.py`.
// Timeout 15 min. Răspuns JSON { success, output } sau { success:false, error }.
// NU atinge scoring-ul; doar regenerează ml/model_live_export.json.
import { runPython } from './train-model.js';

export default async function handler(req, res) {
  const r = await runPython('ml/train_live_v2.py');
  res.status(r.success ? 200 : 500).json(r);
}
