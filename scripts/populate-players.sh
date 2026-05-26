#!/bin/bash
echo "1/3 players-season..."
curl -s http://localhost:3000/api/cron/collect-players-season | tail -c 100
echo ""
echo "2/3 squads..."
curl -s http://localhost:3000/api/cron/collect-squads | tail -c 100
echo ""
echo "3/3 top-scorers..."
curl -s http://localhost:3000/api/cron/collect-top-scorers | tail -c 100
echo ""
echo "GATA"
