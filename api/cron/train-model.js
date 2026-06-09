// api/cron/train-model.js — rulează ml/train_model.py (antrenare ML PRE-MECI).
// POST/GET /api/cron/train-model
//
// Mecanism: spawn `bash -c` care sursează .env EXACT ca în crontab
// (set -a && . .env && set +a) și rulează `python3 -u ml/train_model.py`.
// Timeout 15 min (procesul e ucis dacă depășește). Răspuns JSON:
//   { success: true, output: '...' }  sau  { success: false, error, output }.
// NU atinge scoring-ul; doar regenerează ml/model_export.json.
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const TIMEOUT_MS = 15 * 60 * 1000;   // 15 min
const MAX_OUT = 200_000;             // limitează bufferul de output în răspuns

export function runPython(scriptRel, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    // Sursează .env ca în crontab + PATH sigur (python3 din /usr/bin).
    const cmd =
      'export PATH="/usr/local/bin:/usr/bin:/bin:/snap/bin:$PATH"; ' +
      `set -a && . "${REPO_ROOT}/.env" && set +a && python3 -u "${scriptRel}"`;
    const child = spawn('bash', ['-c', cmd], { cwd: REPO_ROOT });
    let out = '', err = '';
    const tail = (s) => (s.length > MAX_OUT ? s.slice(-MAX_OUT) : s);
    child.stdout.on('data', (d) => { out = tail(out + d.toString()); });
    child.stderr.on('data', (d) => { err = tail(err + d.toString()); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ success: false, error: `Timeout după ${Math.round(timeoutMs / 60000)} min`,
        output: tail(out + (err ? '\n[stderr]\n' + err : '')) });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ success: false, error: e.message, output: tail(out + err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const combined = tail(out + (err ? '\n[stderr]\n' + err : ''));
      if (code === 0) resolve({ success: true, output: combined });
      else resolve({ success: false, error: `exit code ${code}`, output: combined });
    });
  });
}

export default async function handler(req, res) {
  const r = await runPython('ml/train_model.py');
  res.status(r.success ? 200 : 500).json(r);
}
