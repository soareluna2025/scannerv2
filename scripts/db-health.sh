#!/bin/bash
# ============================================================================
#  db-health.sh — RAPORT SĂNĂTATE DB (read-only) pentru decizii de optimizare.
#  Credențiale DB EXCLUSIV din /root/scannerv2/.env (POSTGRES_URL). Zero parole
#  în output/fișier. Tolerant la erori (un pas picat nu oprește restul).
#  Output: consolă + /root/scannerv2/docs/DB_HEALTH.txt
#  Rulare:  bash scripts/db-health.sh
# ============================================================================
APP_DIR="/root/scannerv2"
OUT="${APP_DIR}/docs/DB_HEALTH.txt"
mkdir -p "${APP_DIR}/docs"
exec > >(tee "${OUT}") 2>&1

set -a; . "${APP_DIR}/.env" 2>/dev/null; set +a
PGURL="${POSTGRES_URL:-}"
if [ -z "${PGURL}" ]; then echo "POSTGRES_URL lipsește din .env — abort."; exit 1; fi

P() { psql "${PGURL}" -X -v ON_ERROR_STOP=0 -P pager=off "$@" 2>&1; }
SEC() { echo ""; echo "════════════════════════════════════════════════════════════════════════"; echo "  $1"; echo "════════════════════════════════════════════════════════════════════════"; }
Q() { echo ""; echo "── $1 ──"; P -c "$2" || echo "  (eroare, continuă)"; }

echo "DB HEALTH — $(date '+%Y-%m-%d %H:%M:%S')  ·  $(P -tAc 'SELECT current_database()||\" @ \"||version()' 2>/dev/null | head -1)"

# ── 1 ──────────────────────────────────────────────────────────────────────
SEC "SECȚIUNEA 1 — Per tabel (rânduri vii/moarte, mărimi), ordonat după mărime"
Q "tabele" "
SELECT relname AS tabel, n_live_tup AS vii, n_dead_tup AS moarte,
  CASE WHEN n_live_tup+n_dead_tup>0 THEN round(100.0*n_dead_tup/(n_live_tup+n_dead_tup),1) ELSE 0 END AS pct_moarte,
  pg_size_pretty(pg_table_size(relid))          AS tabel_size,
  pg_size_pretty(pg_indexes_size(relid))        AS idx_size,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC;"

# ── 2 ──────────────────────────────────────────────────────────────────────
SEC "SECȚIUNEA 2 — Istoric întreținere (⚠ autovacuum >7 zile sau dead >10%)"
Q "vacuum/analyze" "
SELECT relname AS tabel, last_vacuum, last_autovacuum, last_analyze, last_autoanalyze,
  autovacuum_count AS av_cnt, autoanalyze_count AS aa_cnt,
  CASE
    WHEN (n_live_tup+n_dead_tup)>0 AND 100.0*n_dead_tup/(n_live_tup+n_dead_tup)>10 THEN '⚠ dead>10%'
    WHEN last_autovacuum IS NULL AND last_vacuum IS NULL AND n_live_tup>1000 THEN '⚠ niciun vacuum'
    WHEN COALESCE(last_autovacuum,last_vacuum) < now()-interval '7 days' AND n_dead_tup>0 THEN '⚠ >7 zile'
    ELSE 'ok' END AS flag
FROM pg_stat_user_tables ORDER BY n_dead_tup DESC;"

# ── 3 ──────────────────────────────────────────────────────────────────────
SEC "SECȚIUNEA 3 — Indecși (❌ idx_scan=0 = candidați la ștergere)"
Q "indecși per tabel" "
SELECT t.relname AS tabel, i.indexrelname AS index,
  pg_size_pretty(pg_relation_size(i.indexrelid)) AS marime,
  i.idx_scan, i.idx_tup_read AS tuples_citite,
  CASE WHEN i.idx_scan=0 THEN '❌ nefolosit'
       WHEN i.idx_scan<50 THEN '⚠ rar' ELSE '' END AS flag
FROM pg_stat_user_indexes i
JOIN pg_stat_user_tables t ON t.relid=i.relid
ORDER BY pg_relation_size(i.indexrelid) DESC;"
Q "spațiu IROSIT pe indecși nefolosiți (idx_scan=0)" "
SELECT count(*) AS indecsi_nefolositi,
  pg_size_pretty(COALESCE(sum(pg_relation_size(indexrelid)),0)) AS spatiu_irosit
FROM pg_stat_user_indexes WHERE idx_scan=0;"
Q "indecși potențial REDUNDANȚI (același tabel + aceeași primă coloană)" "
WITH idx AS (
  SELECT i.indrelid::regclass AS tabel, i.indexrelid::regclass AS idx,
    (SELECT a.attname FROM pg_attribute a WHERE a.attrelid=i.indexrelid AND a.attnum=1) AS prima_coloana
  FROM pg_index i
  JOIN pg_class c ON c.oid=i.indexrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')
SELECT tabel, prima_coloana, count(*) AS nr_indecsi, string_agg(idx::text, ', ') AS indecsi
FROM idx GROUP BY tabel, prima_coloana HAVING count(*)>1 ORDER BY tabel;"

# ── 4 ──────────────────────────────────────────────────────────────────────
SEC "SECȚIUNEA 4 — Tipare acces (⚠ tabel mare cu seq_scan dominant = index lipsă?)"
Q "seq vs idx" "
SELECT relname AS tabel, n_live_tup AS randuri, seq_scan, seq_tup_read, idx_scan,
  CASE WHEN idx_scan>0 THEN round(seq_scan::numeric/idx_scan,2) ELSE NULL END AS seq_per_idx,
  CASE WHEN n_live_tup>100000 AND seq_scan>COALESCE(idx_scan,0) THEN '⚠ posibil index lipsă' ELSE '' END AS flag
FROM pg_stat_user_tables ORDER BY seq_tup_read DESC;"

# ── 5 ──────────────────────────────────────────────────────────────────────
SEC "SECȚIUNEA 5 — Cache hit ratio (⚠ <95% pe tabele fierbinți)"
Q "global" "
SELECT round(100.0*sum(heap_blks_hit)/NULLIF(sum(heap_blks_hit+heap_blks_read),0),2) AS hit_ratio_global_pct
FROM pg_statio_user_tables;"
Q "per tabel (cele cu I/O semnificativ)" "
SELECT relname AS tabel, heap_blks_hit AS hit, heap_blks_read AS read_disk,
  round(100.0*heap_blks_hit/NULLIF(heap_blks_hit+heap_blks_read,0),2) AS hit_ratio,
  CASE WHEN (heap_blks_hit+heap_blks_read)>10000
            AND 100.0*heap_blks_hit/NULLIF(heap_blks_hit+heap_blks_read,0)<95 THEN '⚠ <95%' ELSE '' END AS flag
FROM pg_statio_user_tables WHERE (heap_blks_hit+heap_blks_read)>0
ORDER BY heap_blks_read DESC LIMIT 30;"

# ── 6 ──────────────────────────────────────────────────────────────────────
SEC "SECȚIUNEA 6 — Configurație + RAM server"
Q "parametri cheie + autovacuum" "
SELECT name, setting, unit FROM pg_settings
WHERE name IN ('shared_buffers','work_mem','maintenance_work_mem','effective_cache_size','max_connections')
   OR name LIKE 'autovacuum%' ORDER BY name;"
Q "override-uri autovacuum per tabel (reloptions)" "
SELECT c.relname AS tabel, c.reloptions
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.reloptions IS NOT NULL;"
echo ""; echo "── RAM server (free -m) ──"; free -m 2>&1 || echo "  (free indisponibil)"

# ── 7 ──────────────────────────────────────────────────────────────────────
SEC "SECȚIUNEA 7 — Spațiu"
Q "mărime totală DB" "SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size;"
Q "top 10 obiecte (tabele+indecși)" "
SELECT n.nspname||'.'||c.relname AS obiect,
  CASE c.relkind WHEN 'r' THEN 'tabel' WHEN 'i' THEN 'index' WHEN 't' THEN 'toast' ELSE c.relkind::text END AS tip,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS marime
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','i')
ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10;"
DATADIR=$(P -tAc "SHOW data_directory" 2>/dev/null | head -1)
echo ""; echo "── spațiu disc partiția datelor (${DATADIR:-?}) ──"
df -h "${DATADIR:-/}" 2>&1 || echo "  (df indisponibil)"

# ── 8 ──────────────────────────────────────────────────────────────────────
SEC "SECȚIUNEA 8 — pg_stat_statements (top query-uri)"
HAS_PSS=$(P -tAc "SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements'" 2>/dev/null | head -1)
if [ "$HAS_PSS" = "1" ]; then
  Q "top 10 după timp total" "
  SELECT round(total_exec_time::numeric,0) AS total_ms, calls,
         round(mean_exec_time::numeric,2) AS mean_ms, round(100.0*total_exec_time/SUM(total_exec_time) OVER (),1) AS pct,
         left(regexp_replace(query,'\s+',' ','g'),90) AS query
  FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;"
else
  echo ""; echo "  ℹ pg_stat_statements NU e instalată — secțiune sărită (NU se instalează automat)."
fi

# ── REZUMAT ─────────────────────────────────────────────────────────────────
SEC "REZUMAT"
Q "Cele mai umflate tabele (rânduri moarte)" "
SELECT relname AS tabel, n_dead_tup AS moarte,
  round(100.0*n_dead_tup/NULLIF(n_live_tup+n_dead_tup,0),1) AS pct,
  pg_size_pretty(pg_table_size(relid)) AS size
FROM pg_stat_user_tables WHERE n_dead_tup>0 ORDER BY n_dead_tup DESC LIMIT 5;"
Q "Indecși nefolosiți + spațiu recuperabil" "
SELECT count(*) AS indecsi_idx_scan_0,
  pg_size_pretty(COALESCE(sum(pg_relation_size(indexrelid)),0)) AS spatiu_recuperabil
FROM pg_stat_user_indexes WHERE idx_scan=0;"
Q "Tabele cu autovacuum insuficient (>7 zile / niciodată, cu dead>0)" "
SELECT relname AS tabel, n_dead_tup AS moarte, last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup>0 AND (last_autovacuum IS NULL OR last_autovacuum < now()-interval '7 days')
ORDER BY n_dead_tup DESC LIMIT 10;"
Q "Verdict cache (global)" "
SELECT round(100.0*sum(heap_blks_hit)/NULLIF(sum(heap_blks_hit+heap_blks_read),0),2) AS hit_ratio_pct,
  CASE WHEN 100.0*sum(heap_blks_hit)/NULLIF(sum(heap_blks_hit+heap_blks_read),0) >= 99 THEN 'EXCELENT'
       WHEN 100.0*sum(heap_blks_hit)/NULLIF(sum(heap_blks_hit+heap_blks_read),0) >= 95 THEN 'OK'
       ELSE '⚠ SUB 95% — shared_buffers posibil prea mic' END AS verdict
FROM pg_statio_user_tables;"

echo ""; echo "RAPORT COMPLET. Salvat în: ${OUT}"
