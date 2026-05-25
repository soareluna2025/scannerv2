#!/bin/bash
# Test direct endpoint /venues?team=X
KEY=$(grep API_FOOTBALL_KEY /root/scannerv2/.env | cut -d= -f2 | tr -d '"')
echo "Test 1: /venues?team=33 (Manchester United)"
curl -s -H "x-apisports-key: $KEY" "https://v3.football.api-sports.io/venues?team=33" | python3 -m json.tool 2>/dev/null | head -25
echo ""
echo "Test 2: /venues?team=541 (Real Madrid)"
curl -s -H "x-apisports-key: $KEY" "https://v3.football.api-sports.io/venues?team=541" | python3 -m json.tool 2>/dev/null | head -25
