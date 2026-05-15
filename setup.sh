#!/bin/bash
set -e

echo ""
echo "=============================="
echo "   AlohaScan VPS Setup"
echo "=============================="
echo ""

echo "[1/6] Cheie SSH..."
mkdir -p /root/.ssh && chmod 700 /root/.ssh
KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIO6TrfnS6K/PDmx5tZpgGu1xL67rWfaOziCol6iZAml4 vultr-vps'
grep -qxF "$KEY" /root/.ssh/authorized_keys 2>/dev/null || echo "$KEY" >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
echo "  OK - cheie SSH adaugata"

echo "[2/6] Update sistem..."
apt-get update -y -qq 2>/dev/null
apt-get install -y curl git -qq 2>/dev/null
echo "  OK"

echo "[3/6] Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
apt-get install -y nodejs -qq 2>/dev/null
echo "  Node: $(node -v) | npm: $(npm -v)"

echo "[4/6] PM2..."
npm install -g pm2 --silent
PM2_STARTUP=$(pm2 startup systemd -u root --hp /root 2>/dev/null | grep "sudo")
if [ -n "$PM2_STARTUP" ]; then
  eval "$PM2_STARTUP" > /dev/null 2>&1 || true
fi
echo "  PM2: $(pm2 -v)"

echo "[5/6] Clonare repo AlohaScan..."
rm -rf /root/scannerv2
git clone https://github.com/soareluna2025/scannerv2.git /root/scannerv2 -q
cd /root/scannerv2
npm install --silent
echo "  OK - $(ls node_modules | wc -l) pachete instalate"

echo "[6/6] Creare fisier .env..."
if [ ! -f /root/scannerv2/.env ]; then
cat > /root/scannerv2/.env << 'ENV'
API_FOOTBALL_KEY=
FOOTBALL_DATA_KEY=
SUPABASE_URL=
SUPABASE_KEY=
ANTHROPIC_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
ENV
echo "  .env creat - completeaza cheile API!"
else
echo "  .env exista deja"
fi

echo ""
echo "=============================="
echo "  SETUP COMPLET!"
echo "=============================="
echo ""
echo "Node:  $(node -v)"
echo "npm:   $(npm -v)"
echo "PM2:   $(pm2 -v)"
echo "Repo:  $(git -C /root/scannerv2 log --oneline -1)"
echo "SSH:   $(cat /root/.ssh/authorized_keys | wc -l) cheie(i) autorizate"
echo ""
echo "Urmatorul pas: completeaza /root/scannerv2/.env cu cheile API"
echo ""
