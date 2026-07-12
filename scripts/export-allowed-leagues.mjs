// scripts/export-allowed-leagues.mjs
// Generează ml/allowed_leagues.json din SURSA DE ADEVĂR api/leagues.js
// (ALLOWED_LEAGUE_IDS). Rulat ÎNAINTE de fiecare antrenare Python (setup-crontab.sh)
// → JSON-ul e mereu proaspăt din masterul JS, deci NU poate diverge (zero listă
// hardcodată duplicată). JS-ul (build-ml-features.js) importă direct Set-ul;
// Python-ul (train_model/train_live_v2/calibrate) citește acest JSON.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ALLOWED_LEAGUE_IDS } from '../api/leagues.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ids = [...ALLOWED_LEAGUE_IDS].sort((a, b) => a - b);
const out = join(__dirname, '..', 'ml', 'allowed_leagues.json');
writeFileSync(out, JSON.stringify(ids));
console.log(`[export-allowed-leagues] ${ids.length} ligi whitelist → ${out}`);
