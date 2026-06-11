#!/bin/bash
# ============================================================================
#  schema-stats.sh — STATISTICI SCHEMĂ (read-only). Credențiale din .env
#  (POSTGRES_URL), zero parole în output. Tolerant la erori.
#  Output: consolă + /root/scannerv2/docs/SCHEMA_STATS.txt
#  Rulare:  bash scripts/schema-stats.sh
# ============================================================================
APP_DIR="/root/scannerv2"
OUT="${APP_DIR}/docs/SCHEMA_STATS.txt"
mkdir -p "${APP_DIR}/docs"
exec > >(tee "${OUT}") 2>&1
set -a; . "${APP_DIR}/.env" 2>/dev/null; set +a
PGURL="${POSTGRES_URL:-}"
if [ -z "${PGURL}" ]; then echo "POSTGRES_URL lipsește din .env — abort."; exit 1; fi
P(){ psql "${PGURL}" -X -v ON_ERROR_STOP=0 -P pager=off "$@"; }
SEC(){ echo ""; echo "════════════════════════════════════════════════════════════"; echo "  $1"; echo "════════════════════════════════════════════════════════════"; }
Q(){ echo ""; echo "── $1 ──"; P -c "$2" || echo "  (eroare, continuă)"; }

echo "SCHEMA STATS — $(date '+%Y-%m-%d %H:%M:%S')"

# 1 — rânduri + mărime per tabel
SEC "1. Rânduri (live) + mărime per tabel"
Q "tabele" "
SELECT relname AS tabel, n_live_tup AS randuri,
  pg_size_pretty(pg_table_size(relid))          AS tabel_size,
  pg_size_pretty(pg_indexes_size(relid))        AS idx_size,
  pg_size_pretty(pg_total_relation_size(relid)) AS total
FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC;"

# 2 — top tabele după SCRIERI (ins/upd/del)
SEC "2. Top tabele după SCRIERI (n_tup_ins/upd/del)"
Q "scrieri" "
SELECT relname AS tabel, n_tup_ins AS ins, n_tup_upd AS upd, n_tup_del AS del,
  (n_tup_ins+n_tup_upd+n_tup_del) AS scrieri_total,
  n_dead_tup AS moarte, autovacuum_count AS av
FROM pg_stat_user_tables ORDER BY (n_tup_ins+n_tup_upd+n_tup_del) DESC LIMIT 20;"

# 3 — distribuția cheilor app_settings (top 20 prefixe)
SEC "3. app_settings — distribuția cheilor (top 20 prefixe)"
Q "total rânduri app_settings" "SELECT count(*) AS total_app_settings FROM app_settings;"
Q "top 20 prefixe (înainte de primul ':')" "
SELECT split_part(key,':',1) AS prefix, count(*) AS randuri,
  pg_size_pretty(sum(pg_column_size(key)+pg_column_size(value))::bigint) AS marime_aprox
FROM app_settings GROUP BY 1 ORDER BY 2 DESC LIMIT 20;"
Q "exemple chei per prefix top 5" "
SELECT split_part(key,':',1) AS prefix, (array_agg(key ORDER BY updated_at DESC))[1] AS exemplu_recent,
  min(updated_at) AS cel_mai_vechi, max(updated_at) AS cel_mai_nou
FROM app_settings GROUP BY 1 ORDER BY count(*) DESC LIMIT 5;"

# 4 — candidați zombi: tabele cu 0 rânduri (confirmă bookmakers / h)
SEC "4. Tabele cu 0 rânduri (candidați zombi de confirmat)"
Q "goale" "SELECT relname AS tabel FROM pg_stat_user_tables WHERE n_live_tup=0 ORDER BY relname;"

# 5 — pg_stat_statements (dacă există): top 15 după timp total
SEC "5. Top 15 query-uri (pg_stat_statements, dacă există)"
HAS=$(P -tAc "SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements'" 2>/dev/null | head -1)
if [ "$HAS" = "1" ]; then
  Q "top 15 după total_exec_time" "
  SELECT round(total_exec_time::numeric,0) AS total_ms, calls,
    round(mean_exec_time::numeric,2) AS mean_ms,
    round(100.0*total_exec_time/SUM(total_exec_time) OVER (),1) AS pct,
    left(regexp_replace(query,'\s+',' ','g'),100) AS query
  FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 15;"
else
  echo ""; echo "  ℹ pg_stat_statements NU e activă (rulează db-optimize-phase1.sh pt a o activa)."
fi

echo ""; echo "GATA. Salvat în: ${OUT}"
