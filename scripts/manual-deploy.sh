#!/usr/bin/env bash
# Deploy MANUAL pe VPS — echivalentul pașilor de cod din .github/workflows/deploy.yml,
# pentru când GitHub Actions nu poate face SSH (ex: parolă/IP schimbat).
# NU scrie .env. Instalează crontab-ul canonic (inclusiv auto-deploy + watchdog) + codul + PM2.
#
# Rulare (o singură linie, din Termius):
#   cd /root/scannerv2 && git fetch origin && git checkout origin/main -- scripts/manual-deploy.sh && bash scripts/manual-deploy.sh
set -u
export PATH="/snap/bin:$PATH"
cd /root/scannerv2 || { echo "EROARE: /root/scannerv2 nu există"; exit 1; }

echo "== 1/5 Salvez artefactele ML (gitignored) =="
for f in model_live_export.json model_export.json calibration_export.json calibration_live_export.json gg_calibration.json; do
  cp "ml/$f" "/tmp/$f.bak" 2>/dev/null || true
done

echo "== 2/5 git fetch + reset --hard origin/main =="
git fetch origin || { echo "EROARE: git fetch a eșuat"; exit 1; }
git reset --hard origin/main || { echo "EROARE: git reset a eșuat"; exit 1; }
echo "Commit curent: $(git rev-parse --short HEAD)"

echo "== 3/5 Restaurez artefactele ML =="
for f in model_live_export.json model_export.json calibration_export.json calibration_live_export.json gg_calibration.json; do
  cp "/tmp/$f.bak" "ml/$f" 2>/dev/null || true
done

echo "== 4/5 npm install =="
npm install --silent || echo "ATENȚIE: npm install a dat eroare (verifică manual)"

echo "== 4b. Salvez calea pm2 + instalez crontab (incl. auto-deploy + watchdog) =="
command -v pm2 > /root/.pm2_bin 2>/dev/null || true
mkdir -p /root/scripts && cp scripts/backup-db.sh /root/scripts/backup-db.sh 2>/dev/null && chmod +x /root/scripts/backup-db.sh
bash scripts/setup-crontab.sh >/dev/null 2>&1 && echo "Crontab instalat" || echo "ATENȚIE: setup-crontab.sh a eșuat (CRON_SECRET lipsește din .env?)"

echo "== 5/5 Restart PM2 =="
pm2 restart alohascan || { pm2 start ecosystem.config.cjs && pm2 save; }
sleep 4
pm2 describe alohascan >/dev/null 2>&1 && echo "ALOHASCAN: ONLINE (pm2)" || echo "ALOHASCAN: ERROR — verifică: pm2 logs alohascan --lines 50"
curl -sf http://localhost:3000/health && echo " <- HEALTH OK" || echo "HEALTH FAILED — verifică: pm2 logs alohascan --lines 50"
echo "Deploy manual complet: $(date)"
