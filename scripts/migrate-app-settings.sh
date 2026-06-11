#!/bin/bash
# ============================================================================
#  migrate-app-settings.sh — mută markerii no_data:*/h2h_refresh:* din
#  app_settings (763k rânduri) în tabelul dedicat api_markers, apoi îi șterge
#  din app_settings și face VACUUM ANALYZE. Markerii NU se pierd (previn
#  re-arderea API) — doar se mută. Idempotent (ON CONFLICT DO NOTHING).
#  Credențiale din .env. Rulare:  bash scripts/migrate-app-settings.sh
# ============================================================================
APP_DIR="/root/scannerv2"
set -a; . "${APP_DIR}/.env" 2>/dev/null; set +a
PGURL="${POSTGRES_URL:-}"
if [ -z "${PGURL}" ]; then echo "POSTGRES_URL lipsește din .env — abort."; exit 1; fi
P(){ psql "${PGURL}" -X -v ON_ERROR_STOP=0 -P pager=off -c "$1"; }

echo "MIGRARE app_settings → api_markers — $(date '+%Y-%m-%d %H:%M:%S')"
P "SELECT count(*) AS app_settings_inainte FROM app_settings;"

P "CREATE TABLE IF NOT EXISTS api_markers (
     kind TEXT NOT NULL, ref_key TEXT NOT NULL,
     created_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (kind, ref_key));"

# no_data:<sub>:<ref...>  →  kind='no_data:<sub>', ref_key=<ref...>
#   ex. 'no_data:stats:123'        → kind='no_data:stats',   ref='123'
#       'no_data:players:45:2024'  → kind='no_data:players', ref='45:2024'
P "INSERT INTO api_markers (kind, ref_key, created_at)
   SELECT 'no_data:' || split_part(key, ':', 2) AS kind,
          substring(key from length('no_data:' || split_part(key, ':', 2)) + 2) AS ref_key,
          COALESCE(updated_at, NOW())
     FROM app_settings WHERE key LIKE 'no_data:%'
   ON CONFLICT (kind, ref_key) DO NOTHING;"

# h2h_refresh:<t1>:<t2>  →  kind='h2h_refresh', ref_key='<t1>:<t2>'
P "INSERT INTO api_markers (kind, ref_key, created_at)
   SELECT 'h2h_refresh', substring(key from 13), COALESCE(updated_at, NOW())
     FROM app_settings WHERE key LIKE 'h2h_refresh:%'
   ON CONFLICT (kind, ref_key) DO NOTHING;"

P "SELECT kind, count(*) FROM api_markers GROUP BY kind ORDER BY 2 DESC;"

# Șterge markerii migrați din app_settings (cheile singleton backfill_*/extract_* RĂMÂN).
P "DELETE FROM app_settings WHERE key LIKE 'no_data:%' OR key LIKE 'h2h_refresh:%';"
P "VACUUM ANALYZE app_settings;"
P "VACUUM ANALYZE api_markers;"

P "SELECT count(*) AS app_settings_dupa FROM app_settings;"
echo "GATA. app_settings ar trebui să rămână doar cu cheile de config (≈ <30 rânduri)."
