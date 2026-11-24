#!/usr/bin/env bash
# pre-deploy-backup.sh — rulat INAINTE de orice `git reset --hard`. Daca pe VPS exista modificari
# locale la fisiere urmarite de Git (hotfix pus direct / din branch), le salveaza ca patch + copii,
# ca deploy-ul sa nu le mai STEARGA fara urma. Nu opreste deploy-ul si nu modifica nimic in repo.
cd /root/scannerv2 2>/dev/null || exit 0
CH=$(git status --porcelain --untracked-files=no 2>/dev/null)
[ -z "$CH" ] && exit 0
D=/root/deploy-backups/$(date +%Y%m%d_%H%M%S)
mkdir -p "$D"
git diff HEAD > "$D/local-changes.patch" 2>/dev/null
echo "$CH" > "$D/files.txt"
echo "$CH" | awk '{print $2}' | while read -r f; do [ -f "$f" ] && mkdir -p "$D/files/$(dirname "$f")" && cp "$f" "$D/files/$f"; done
echo "[pre-deploy-backup] $(echo "$CH" | wc -l) fisiere modificate local salvate in $D (patch: local-changes.patch)"
ls -1dt /root/deploy-backups/*/ 2>/dev/null | tail -n +21 | xargs -r rm -rf   # pastreaza ultimele 20
exit 0
