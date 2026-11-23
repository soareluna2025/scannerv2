#!/usr/bin/env bash
# watchdog.sh — repornește aplicația dacă /health nu răspunde (2 verificări la 20s distanță,
# ca să nu lovească un restart de deploy în desfășurare). Rulat din cron la 5 minute.
set -u
PM2_BIN=$(cat /root/.pm2_bin 2>/dev/null || true)
[ -n "$PM2_BIN" ] || PM2_BIN=pm2
export PATH="/snap/bin:/usr/local/bin:/usr/bin:/bin:$(dirname "$PM2_BIN"):$PATH"
ok() { curl -sf -m 8 http://localhost:3000/health >/dev/null 2>&1; }
ok && exit 0
sleep 20
ok && exit 0
echo "[$(date '+%F %T')] WATCHDOG: /health nu răspunde — pm2 restart alohascan"
"$PM2_BIN" restart alohascan >/dev/null 2>&1 || "$PM2_BIN" start /root/scannerv2/ecosystem.config.cjs >/dev/null 2>&1
