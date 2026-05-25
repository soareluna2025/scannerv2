#!/bin/bash
# Ruleaza collect-team-stats manual (40 echipe/run, sezon 2025)
# Usage: ./scripts/collect-team-stats-now.sh [limit] [season]
LIMIT=${1:-40}
SEASON=${2:-2025}
echo "[$(date '+%H:%M:%S')] collect-team-stats limit=$LIMIT season=$SEASON"
curl -s "http://localhost:3000/api/cron/collect-team-stats?limit=$LIMIT&season=$SEASON" | node -e "
const c=[]; process.stdin.on('data',d=>c.push(d)); process.stdin.on('end',()=>{
  try { const r=JSON.parse(Buffer.concat(c));
    console.log('ok:', r.ok, '| pairs:', r.pairs_found, '| upserted:', r.upserted, '| total_db:', r.total_in_db);
    if(r.sample?.length) console.log('sample:', JSON.stringify(r.sample.slice(0,3)));
    if(r.error) console.error('error:', r.error);
  } catch(e){ console.error('parse error:', e.message); }
});"
