#!/bin/bash
# Verificare Hybrid V2: health + Layer8 + collect-finished + prediction_log
APP="http://localhost:3000"
export PGPASSWORD=Firenze225854
PG() { psql -U alohascan -d elefant -tA -c "$1" 2>/dev/null; }

echo "=== 1. HEALTH ==="
curl -s $APP/health

echo ""
echo "=== 2. ENRICH — Lambda + Layer8 (fixture 1379332) ==="
curl -s "$APP/api/enrich?h=40&a=50&fid=1379332&lgid=39" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('lambdaHome:', d.get('lambdaHome'))
print('lambdaAway:', d.get('lambdaAway'))
b = d.get('breakdown', {})
print('breakdown.poisson:    ', b.get('poisson'))
print('breakdown.forma:      ', b.get('forma'))
print('breakdown.putereEchipe:', b.get('putereEchipe'))
print('breakdown.apiConsensus:', b.get('apiConsensus'))
print('_standingsBlend:      ', d.get('_standingsBlend'))
print('confidenceScore:      ', d.get('confidenceScore'))
" 2>/dev/null || echo "EROARE: app nu raspunde sau fixture invalid"

echo ""
echo "=== 3. COLLECT-FINISHED — ultimele 10 rulari ==="
psql -U alohascan -d elefant -c "SELECT ran_at::date AS data, status, COALESCE(LEFT(error_msg,80),'') AS eroare FROM cron_logs WHERE job_name='collect-finished' ORDER BY ran_at DESC LIMIT 10;" 2>/dev/null

echo ""
echo "=== 4. PREDICTION_LOG — stare Brier checkpoint ==="
psql -U alohascan -d elefant -c "SELECT COUNT(*) AS total, COUNT(CASE WHEN outcome IS NOT NULL THEN 1 END) AS cu_outcome, COUNT(CASE WHEN outcome='WIN' THEN 1 END) AS wins, COUNT(CASE WHEN outcome='LOSS' THEN 1 END) AS losses, ROUND(COUNT(CASE WHEN outcome IS NOT NULL THEN 1 END)*100.0/NULLIF(COUNT(*),0),1) AS pct_rezolvat FROM prediction_log;" 2>/dev/null
