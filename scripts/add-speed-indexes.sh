#!/bin/bash
# ============================================================================
#  add-speed-indexes.sh — indecși pe `predictions` / `prediction_log` care
#  opresc seq-scan-urile dovedite de docs/SPEED_AUDIT.md (877k seq scans).
#  CREATE INDEX CONCURRENTLY (fără lock pe scrierile live). Credențiale din .env.
#  Rulare:  bash scripts/add-speed-indexes.sh
# ============================================================================
APP_DIR="/root/scannerv2"
set -a; . "${APP_DIR}/.env" 2>/dev/null; set +a
PGURL="${POSTGRES_URL:-}"
if [ -z "${PGURL}" ]; then echo "POSTGRES_URL lipsește din .env — abort."; exit 1; fi
P(){ psql "${PGURL}" -X -v ON_ERROR_STOP=0 -P pager=off -c "$1"; }

echo "ADD SPEED INDEXES — $(date '+%Y-%m-%d %H:%M:%S')"

# 1) update-results.js:131 — SELECT ... WHERE result_over15 IS NULL AND match_date<NOW()
#    (rulează la resolve-ul rezultatelor; sursa principală a seq-scan-urilor).
echo "── 1/4 idx_pred_unresolved (predictions: pending după dată) ──"
P "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pred_unresolved
   ON predictions (match_date) WHERE result_over15 IS NULL;"

# 2) backfill-predictions.js:142 — COUNT(*) WHERE result_winner IS NOT NULL.
echo "── 2/4 idx_pred_resolved (predictions: rezolvate) ──"
P "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pred_resolved
   ON predictions (result_winner) WHERE result_winner IS NOT NULL;"

# 3) model-accuracy.js:49 — WHERE result_over15 IS NOT NULL AND updated_at>=NOW()-Nd.
echo "── 3/4 idx_pred_acc (predictions: accuracy recentă) ──"
P "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pred_acc
   ON predictions (updated_at) WHERE result_over15 IS NOT NULL;"

# 4) learning-analysis.js:58-66 — pe prediction_log: WHERE outcome<>'PENDING'
#    GROUP BY league_id, module.
echo "── 4/4 idx_predlog_resolved (prediction_log: non-pending per ligă/modul) ──"
P "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_predlog_resolved
   ON prediction_log (league_id, module) WHERE outcome <> 'PENDING';"

echo "── Verificare (indecși noi) ──"
P "SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) AS marime
     FROM pg_stat_user_indexes
    WHERE indexrelname IN ('idx_pred_unresolved','idx_pred_resolved','idx_pred_acc','idx_predlog_resolved')
    ORDER BY indexrelname;"
echo "GATA. (rulează din nou query-urile / db-health.sh ca să vezi seq_scan-ul scăzând)"
