#!/bin/bash
# =============================================================================
# ALOHASCAN — DIAGNOSTIC COMPLET: CE? CAND? CUM? UNDE?
# Rulare: bash scripts/diagnostic-db.sh 2>&1 | tee /tmp/diag-$(date +%Y%m%d-%H%M).txt
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="$SCRIPT_DIR/diagnostic-db.sql"

if [ ! -f "$SQL_FILE" ]; then
  echo "EROARE: Nu gasesc $SQL_FILE"
  exit 1
fi

PGPASSWORD=Firenze225854 psql -U alohascan -d elefant -h 127.0.0.1 -f "$SQL_FILE"
