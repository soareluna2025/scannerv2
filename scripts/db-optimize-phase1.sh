#!/bin/bash
# ============================================================================
#  db-optimize-phase1.sh — OPTIMIZARE DB FAZA 1 (pe baza docs/DB_HEALTH.txt).
#  VPS 2GB RAM, PG local, user app = alohascan (NON-superuser). Config sistem
#  via `sudo -u postgres`; DROP/ALTER/VACUUM (owner) via POSTGRES_URL din .env.
#  Zero parole în output. Aplicația scrie live → folosim DROP INDEX CONCURRENTLY
#  și VACUUM (fără FULL, fără lock-uri lungi). Confirmare ENTER înainte de restart.
#
#  Rulare:  bash scripts/db-optimize-phase1.sh           (interactiv)
#           bash scripts/db-optimize-phase1.sh --yes      (fără promptul de restart)
#           bash scripts/db-optimize-phase1.sh --skip-config   (doar B/C/D, fără restart)
# ============================================================================
APP_DIR="/root/scannerv2"
set -a; . "${APP_DIR}/.env" 2>/dev/null; set +a
PGURL="${POSTGRES_URL:-}"
if [ -z "${PGURL}" ]; then echo "POSTGRES_URL lipsește din .env — abort."; exit 1; fi

YES=0; SKIP_CONFIG=0
for a in "$@"; do
  [ "$a" = "--yes" ] && YES=1
  [ "$a" = "--skip-config" ] && SKIP_CONFIG=1
done

P()  { psql "${PGURL}" -X -v ON_ERROR_STOP=0 -P pager=off "$@"; }      # owner=alohascan
PA() { P -tAc "$1"; }
SEC(){ echo ""; echo "════════════════════════════════════════════════════════════════"; echo "  $1"; echo "════════════════════════════════════════════════════════════════"; }

FREED=0

idx_exists() { [ "$(PA "SELECT 1 FROM pg_class WHERE relkind='i' AND relname='$1'")" = "1" ]; }

# Găsește un index „acoperitor" pe același tabel: aceeași PRIMĂ coloană, ≥ la fel
# de multe coloane, nume diferit, cel mai lung primul.
find_covering() {
  PA "
  WITH c AS (SELECT ix.indrelid AS rel, ix.indkey[0] AS fc, array_length(ix.indkey,1) AS n
             FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid WHERE i.relname='$1')
  SELECT i2.relname
  FROM pg_index ix2 JOIN pg_class i2 ON i2.oid=ix2.indexrelid, c
  WHERE ix2.indrelid=c.rel AND i2.relname<>'$1'
    AND ix2.indkey[0]=c.fc AND array_length(ix2.indkey,1) >= c.n
  ORDER BY array_length(ix2.indkey,1) DESC LIMIT 1;"
}

# Verifică programatic că `cand` e PREFIX al `cov` (aceleași coloane de început)
# și că `cand` NU e unique/PK. Întoarce CONFIRM / SKIP_*.
check_prefix() {
  PA "
  WITH cand AS (
    SELECT array_agg(a.attname ORDER BY k.ord) AS cols, bool_or(ix.indisprimary OR ix.indisunique) AS uc
    FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid
    JOIN unnest(ix.indkey) WITH ORDINALITY k(attnum,ord) ON true
    JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum
    WHERE i.relname='$1'),
  cov AS (
    SELECT array_agg(a.attname ORDER BY k.ord) AS cols
    FROM pg_index ix JOIN pg_class i ON i.oid=ix.indexrelid
    JOIN unnest(ix.indkey) WITH ORDINALITY k(attnum,ord) ON true
    JOIN pg_attribute a ON a.attrelid=ix.indrelid AND a.attnum=k.attnum
    WHERE i.relname='$2')
  SELECT CASE
    WHEN cand.cols IS NULL THEN 'NO_CANDIDATE'
    WHEN cov.cols  IS NULL THEN 'NO_COVERING'
    WHEN cand.uc           THEN 'SKIP_CANDIDATE_UNIQUE'
    WHEN cand.cols = cov.cols[1:array_length(cand.cols,1)] THEN 'CONFIRM'
    ELSE 'SKIP_NOMATCH' END
  FROM cand, cov;"
}

drop_confirmed() {  # $1=candidate $2=covering
  echo ""; echo "  • Candidat: $1   (acoperitor: $2)"
  echo "    def candidat : $(PA "SELECT indexdef FROM pg_indexes WHERE indexname='$1'")"
  echo "    def acoperit.: $(PA "SELECT indexdef FROM pg_indexes WHERE indexname='$2'")"
  local v; v=$(check_prefix "$1" "$2" | tr -d '[:space:]')
  if [ "$v" = "CONFIRM" ]; then
    local sz; sz=$(PA "SELECT pg_relation_size('$1'::regclass)" 2>/dev/null); sz=${sz:-0}
    echo "    → CONFIRMAT duplicat. DROP INDEX CONCURRENTLY $1 ($(PA "SELECT pg_size_pretty($sz::bigint)"))"
    if P -c "DROP INDEX CONCURRENTLY IF EXISTS $1;" >/dev/null 2>&1; then
      FREED=$((FREED + sz)); echo "    ✓ șters"
    else echo "    ✗ eroare la DROP (vezi mai sus)"; fi
  else
    echo "    → SKIP ($v) — NU se șterge"
  fi
}

drop_unused() {  # $1=index nefolosit (idx_scan=0, non-PK)
  echo ""; echo "  • Nefolosit: $1"
  if ! idx_exists "$1"; then echo "    → SKIP (nu există)"; return; fi
  echo "    def: $(PA "SELECT indexdef FROM pg_indexes WHERE indexname='$1'")"
  local scan uc; scan=$(PA "SELECT s.idx_scan FROM pg_stat_user_indexes s JOIN pg_class c ON c.oid=s.indexrelid WHERE c.relname='$1'")
  uc=$(PA "SELECT (ix.indisprimary OR ix.indisunique) FROM pg_index ix JOIN pg_class c ON c.oid=ix.indexrelid WHERE c.relname='$1'")
  if [ "$uc" = "t" ]; then echo "    → SKIP (unique/PK — nu se atinge)"; return; fi
  if [ "$scan" = "0" ]; then
    local sz; sz=$(PA "SELECT pg_relation_size('$1'::regclass)" 2>/dev/null); sz=${sz:-0}
    echo "    → idx_scan=0 confirmat. DROP INDEX CONCURRENTLY $1 ($(PA "SELECT pg_size_pretty($sz::bigint)"))"
    if P -c "DROP INDEX CONCURRENTLY IF EXISTS $1;" >/dev/null 2>&1; then
      FREED=$((FREED + sz)); echo "    ✓ șters"
    else echo "    ✗ eroare la DROP"; fi
  else
    echo "    → SKIP (idx_scan=$scan, nu mai e 0 — index folosit)"
  fi
}

echo "DB OPTIMIZE FAZA 1 — $(date '+%Y-%m-%d %H:%M:%S')"

# ── A) CONFIG (necesită restart) ────────────────────────────────────────────
if [ "$SKIP_CONFIG" = "0" ]; then
  SEC "A) CONFIG (ALTER SYSTEM via sudo -u postgres) + restart PG + pm2"
  echo "Se vor seta: shared_buffers=512MB, effective_cache_size=1200MB,"
  echo "             maintenance_work_mem=192MB, shared_preload_libraries=pg_stat_statements"
  sudo -u postgres psql -d elefant -c "ALTER SYSTEM SET shared_buffers='512MB';"
  sudo -u postgres psql -d elefant -c "ALTER SYSTEM SET effective_cache_size='1200MB';"
  sudo -u postgres psql -d elefant -c "ALTER SYSTEM SET maintenance_work_mem='192MB';"
  sudo -u postgres psql -d elefant -c "ALTER SYSTEM SET shared_preload_libraries='pg_stat_statements';"
  echo ""
  echo "⚠ URMEAZĂ RESTART PostgreSQL (downtime ~5s) + pm2 restart alohascan."
  if [ "$YES" = "0" ]; then
    read -r -p "   Apasă ENTER ca să continui, sau Ctrl+C ca să oprești... " _
  fi
  sudo systemctl restart postgresql && sleep 3 && pm2 restart alohascan
  sleep 2
  sudo -u postgres psql -d elefant -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"
  echo "── Verificare ──"
  sudo -u postgres psql -d elefant -c "SHOW shared_buffers;"
  sudo -u postgres psql -d elefant -c "SHOW effective_cache_size;"
  sudo -u postgres psql -d elefant -c "SELECT count(*) AS pg_stat_statements_rows FROM pg_stat_statements;" 2>&1 || echo "  (pg_stat_statements încă neîncărcat — verifică shared_preload_libraries după restart)"
else
  SEC "A) CONFIG — SĂRIT (--skip-config)"
fi

# ── B) CURĂȚARE INDECȘI (DROP INDEX CONCURRENTLY, doar confirmat) ───────────
SEC "B) CURĂȚARE INDECȘI — duplicate confirmate + nefolosiți (idx_scan=0)"
echo ">> Duplicate (candidat = prefix al unui acoperitor pe același tabel):"
for c in idx_match_events_fixture idx_elo_history_fixture idx_h2h_teams idx_fh_home_team idx_fh_away_team; do
  if ! idx_exists "$c"; then echo ""; echo "  • $c → nu există, SKIP"; continue; fi
  cov=$(find_covering "$c" | tr -d '[:space:]')
  if [ -n "$cov" ]; then drop_confirmed "$c" "$cov"; else echo ""; echo "  • $c → niciun acoperitor găsit, SKIP"; fi
done
echo ""; echo ">> live_stats: păstrează cel mai cuprinzător (drop pe cel care e prefix):"
drop_confirmed idx_live_stats_fixture     idx_live_stats_fixture_id
drop_confirmed idx_live_stats_fixture_id  idx_live_stats_fixture
echo ""; echo ">> Nefolosiți (idx_scan=0, non-PK):"
for u in idx_predlog_league idx_alerts_fixture idx_elo_league idx_match_snapshots_league; do
  drop_unused "$u"
done
echo ""; echo "── SPAȚIU TOTAL ELIBERAT (indecși): $(PA "SELECT pg_size_pretty(${FREED}::bigint)") ──"

# ── C) AUTOVACUUM PER-TABEL (owner alohascan, fără restart) ──────────────────
SEC "C) AUTOVACUUM per-tabel (scale_factor mai agresiv pe tabelele active)"
for t in fixtures_history match_events odds h2h predictions squads teams standings leagues; do
  P -c "ALTER TABLE $t SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_analyze_scale_factor=0.02);" \
    && echo "  $t → 0.02/0.02"
done
for t in player_stats prediction_log; do
  P -c "ALTER TABLE $t SET (autovacuum_vacuum_scale_factor=0.05, autovacuum_analyze_scale_factor=0.05);" \
    && echo "  $t → 0.05/0.05"
done

# ── D) VACUUM ANALYZE punctual (fără FULL) ──────────────────────────────────
SEC "D) VACUUM ANALYZE punctual (curăță morții de azi; fără VACUUM FULL)"
for t in fixtures_history teams squads standings leagues top_scorers fixtures; do
  echo "  VACUUM ANALYZE $t ..."
  P -c "VACUUM (ANALYZE) $t;" >/dev/null 2>&1 && echo "    ✓ ok" || echo "    ✗ eroare/tabel inexistent (skip)"
done

SEC "FAZA 1 COMPLETĂ — $(date '+%Y-%m-%d %H:%M:%S')"
echo "Indecși eliberați total: $(PA "SELECT pg_size_pretty(${FREED}::bigint)")"
echo "Recomandare: rulează din nou scripts/db-health.sh ca să confirmi efectul."
