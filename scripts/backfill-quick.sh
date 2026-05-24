#!/bin/bash
# Quick backfill helper - elimina nevoia de a tasta URL-uri lungi din iPhone
# Usage:
#   bash scripts/backfill-quick.sh h2h 2000          # backfill 2000 meciuri h2h
#   bash scripts/backfill-quick.sh match_stats 200   # backfill 200 match_stats
#   bash scripts/backfill-quick.sh all 500           # ambele, 500 fiecare

set -e

TYPE=${1:-h2h}
LIMIT=${2:-200}

KEY=$(grep ADMIN_API_KEY /root/scannerv2/.env 2>/dev/null | cut -d= -f2)
if [ -z "$KEY" ]; then
  echo "❌ ADMIN_API_KEY lipseste din /root/scannerv2/.env"
  exit 1
fi

echo "🔄 Backfill type=$TYPE limit=$LIMIT ..."
echo ""
curl -s "http://localhost:3000/api/backfill-stats?key=${KEY}&type=${TYPE}&limit=${LIMIT}"
echo ""
echo ""
echo "✓ Gata."
