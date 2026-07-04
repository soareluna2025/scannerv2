import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';

process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] unhandledRejection:', reason && reason.stack ? reason.stack : reason);
});
// Loghează semnalele externe (systemd/PM2/OOM) — dacă procesul e oprit din afară,
// logurile JS rămân goale; aceste handler-e dezvăluie cine/ce îl termină.
process.on('SIGTERM', () => { console.error('[FATAL] SIGTERM primit (oprire externă: systemd/PM2)'); process.exit(0); });
process.on('SIGINT',  () => { console.error('[FATAL] SIGINT primit');  process.exit(0); });
process.on('warning', (w) => { console.warn('[node warning]', w && w.message); });
process.on('exit', (code) => { console.error('[FATAL] process exit, code=', code); });
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { timingSafeEqual } from 'crypto';
import { query } from './api/db.js';
import { initBackfillProgress, startBackfill, stopBackfill, getBackfillStatus, resumeOnStartup } from './api/backfill.js';
import { startScanner } from './api/cron/scanner.js';
import adminRouter from './api/admin.js';
import { loadModelWeights } from './api/weights.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ── [SECURITY P0] Helpers auth intern (timing-safe) + limitare endpointuri scumpe ──
function eqSecret(a, b) {
  if (!a || !b) return false;
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
// Autentificare INTERNĂ: acceptă x-cron-secret (crontab) SAU X-Api-Key = INTERNAL/ADMIN.
function isInternalAuthed(req) {
  const xk = req.headers['x-api-key'], xc = req.headers['x-cron-secret'];
  return eqSecret(xc, process.env.CRON_SECRET)
      || eqSecret(xk, process.env.INTERNAL_API_KEY)
      || eqSecret(xk, process.env.ADMIN_API_KEY);
}
// /api/* care SCRIU DB / nu-s necesare frontendului public → auth intern obligatoriu.
const PROTECTED_API = new Set(['update-results']);
// Publice DAR scumpe (Claude API / API-Football) → limitare per-IP (NU cheie — frontendul le folosește).
const RATE_LIMITED_API = new Set(['agent', 'simulate']);
const _expBuckets = new Map();
function allowExpensive(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?').split(',')[0].trim();
  const now = Date.now();
  const e = _expBuckets.get(ip);
  if (!e || now > e.resetAt) { _expBuckets.set(ip, { count: 1, resetAt: now + 60_000 }); return true; }
  if (e.count >= 20) return false;   // 20 req/min/IP pentru agent+simulate
  e.count++; return true;
}
// Căi de SURSĂ/config care NU trebuie servite static (divulgare cod). NU prinde rutele /api
// reale (fără extensie) — doar fișiere .js/.py/... sub dir-uri de sursă + fișiere-cheie din root.
const _SRC_BLOCK = /(^\/(api|ml|scripts|docs|node_modules)\/.*\.[a-z0-9]+$)|(\.(cjs|mjs|py|sql|sh|lock|ya?ml|log|map|env)$)|(^\/(server\.js|package(-lock)?\.json|ecosystem\.config\.cjs|audit_lineups\.js|verify_score4\.js)$)/i;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// [SECURITY P0 — FIX1] Blochează servirea codului sursă/config ÎNAINTE de static.
// GET /server.js /api/enrich.js /ml/calibrate.py /.env /package.json → 404.
app.use((req, res, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && _SRC_BLOCK.test(req.path)) {
    return res.status(404).end();
  }
  next();
});
// Static files (index.html, icons, manifest, service-worker) — sursa deja blocată mai sus.
app.use(express.static(__dirname, { index: 'index.html', dotfiles: 'deny' }));
// Public static (CSS extras, future JS modules)
// Forțează browserul să reîncarce mereu modulele JS din public/js/ (fără cache)
// — restul fișierelor din public/ păstrează caching-ul implicit serve-static.
app.use(express.static(join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') && /[\\/]js[\\/]/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

// API routes — mapate direct la handler-ele Vercel
import { logError } from './api/db.js';
import { logCronRun, ensureCronLogColumns } from './api/utils/cron-log.js';

// [P19] Rute moarte eliminate: players, db-stats, backfill-stats, debug-live (0 referințe
// UI — fișierele șterse) + elo, monte-carlo, match-momentum (fără apel HTTP; fișierele
// rămân, importate direct de simulate.js).
const apiFiles = [
  'football', 'today', 'enrich', 'match',
  'agent', 'update-results', 'health-check', 'simulate', 'generator',
  'standings-data', 'venue-weather', 'learning-leagues',
  'calibration', 'matches-history', 'model-accuracy', 'team', 'worldcup', 'worldcup-qualifiers'
];

for (const name of apiFiles) {
  app.all(`/api/${name}`, async (req, res) => {
    // [SECURITY P0 — FIX2] mutante → auth intern; publice-scumpe → limitare per-IP.
    if (PROTECTED_API.has(name) && !isInternalAuthed(req)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    if (RATE_LIMITED_API.has(name) && !allowExpensive(req)) {
      return res.status(429).json({ ok: false, error: 'Rate limit (20/min)' });
    }
    try {
      const mod = await import(`./api/${name}.js`);
      await mod.default(req, res);
    } catch (e) {
      console.error(`[${name}]`, e.message);
      logError(name, e.message);  // vizibil in admin -> Erori Recente
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });
}

// Cron routes
const cronFiles = ['collect-daily', 'collect-finished', 'prematch-enrichment', 'league-stats', 'referee-stats', 'learning-analysis', 'recalibrate-tables', 'calibrate-live', 'collect-venues', 'collect-coaches', 'coach-stats', 'referee-extended', 'collect-top-scorers', 'collect-players-season', 'collect-squads', 'cazarma-router', 'auto-predict', 'backfill-pass-shots', 'backfill-players', 'extract-team', 'collect-national-history', 'collect-wc-qualifiers', 'build-elo', 'cleanup-settings', 'build-ml-features', 'train-model', 'train-live', 'optimize-db'];
for (const name of cronFiles) {
  app.all(`/api/cron/${name}`, async (req, res) => {
    // Auth cron — blochează apelurile externe neautorizate (cotă API / DELETE-uri).
    // Crontab-ul local trimite header x-cron-secret (vezi scripts/setup-crontab.sh).
    // [SECURITY P0 — FIX3] CRON_SECRET OBLIGATORIU (fără el → 503, nu deschis);
    // DOAR header x-cron-secret (fără fallback ?_secret= care ajungea în logs); timing-safe.
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      return res.status(503).json({ ok: false, error: 'CRON_SECRET not configured' });
    }
    if (!eqSecret(req.headers['x-cron-secret'], cronSecret)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    try {  // catch-block jos logheaza in cron_logs
      const _t0 = Date.now();
      const mod = await import(`./api/cron/${name}.js`);
      await mod.default(req, res);
      // Logging UNIFORM: fiecare execuție lasă urmă în cron_logs (status din HTTP).
      logCronRun(name, _t0, { status: (res.statusCode && res.statusCode < 400) ? 'ok' : 'error' });
    } catch (e) {
      console.error(`[cron/${name}]`, e.message);
      logError(`cron-${name}`, e.message);  // vizibil in admin -> Erori Recente
      logCronRun(name, Date.now(), { status: 'error', error: e.message });
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });
}

// Admin routes (protejate cu X-Api-Key)
app.use('/api/admin', adminRouter);

// Admin dashboard HTML
app.get('/admin', (req, res) => {
  res.sendFile(join(__dirname, 'admin.html'));
});

// Health check (public)
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime_s: Math.round(process.uptime()) });
});

// Backfill routes
app.post('/api/backfill/start', async (req, res) => {
  if (!isInternalAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });  // [SECURITY P0]
  try {
    // FIX6 — param opțional league_id / season (query sau body) pentru start țintit.
    const leagueId = req.query.league_id || req.body?.league_id || null;
    const season   = req.query.season    || req.body?.season    || null;
    const result = await startBackfill({ leagueId, season });
    res.json(result);
  } catch (e) {
    logError('backfill', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/backfill/stop', async (req, res) => {
  if (!isInternalAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });  // [SECURITY P0]
  try {
    const result = await stopBackfill();
    res.json(result);
  } catch (e) {
    logError('backfill', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/backfill/status', async (req, res) => {
  if (!isInternalAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });  // [SECURITY P0]
  try {
    const result = await getBackfillStatus();
    res.json(result);
  } catch (e) {
    logError('backfill', e.message);
    res.status(500).json({ error: e.message });
  }
});

// SPA fallback — toate rutele necunoscute servesc index.html
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

// [SECURITY P0 — BONUS] Error handler: NU divulga stack trace (ex. URIError la path-traversal
// %c0%af). Loghează intern, răspunde sec. Trebuie ultimul (middleware cu 4 argumente).
app.use((err, req, res, next) => {
  console.error('[err]', req.method, req.originalUrl, err && err.message);
  if (res.headersSent) return next(err);
  res.status(err instanceof URIError ? 400 : 500).json({ error: 'Bad request' });
});

// [C1] Aplică idempotent indecșii de performanță la pornire (scripts/add-indexes.sql).
// Fire-and-forget — CREATE INDEX IF NOT EXISTS construiește o singură dată; la
// restart-urile ulterioare e no-op. Garantează indecșii fără psql manual pe VPS.
async function ensureIndexes() {
  try {
    const { readFileSync } = await import('fs');
    const sql = readFileSync(join(__dirname, 'scripts', 'add-indexes.sql'), 'utf8');
    await query(sql);
    console.log('[indexes] add-indexes.sql aplicat (idempotent)');
  } catch (e) {
    console.error('[indexes] ensureIndexes:', e.message);
  }
}

// [E1] Aplică idempotent coloanele lipsă din `predictions` (api_*_pct, result_winner)
// la pornire, rulând migrarea existentă scripts/migrations/add-prediction-api-columns.sql.
// ADD COLUMN IF NOT EXISTS → no-op la restart-urile ulterioare. Elimină nevoia de
// `psql` manual pe VPS; fără asta /api/admin/vs-api dădea 500 (coloane inexistente).
async function ensureColumns() {
  try {
    const { readFileSync } = await import('fs');
    const sql = readFileSync(join(__dirname, 'scripts', 'migrations', 'add-prediction-api-columns.sql'), 'utf8');
    await query(sql);
    console.log('[columns] add-prediction-api-columns.sql aplicat (idempotent)');
  } catch (e) {
    console.error('[columns] ensureColumns:', e.message);
  }
  // [ML] Features per predicție (score1-7 + h2h_sample + league_group) — idempotent.
  try {
    const { readFileSync } = await import('fs');
    const sql = readFileSync(join(__dirname, 'scripts', 'migrations', 'add-prediction-features.sql'), 'utf8');
    await query(sql);
    console.log('[columns] add-prediction-features.sql aplicat (idempotent)');
  } catch (e) {
    console.error('[columns] ensureColumns (features):', e.message);
  }
  // [GOLD] Coloane „recolta de aur" (referee/formații/goals_prevented/standings
  // splits/api comparison) — idempotent, ADD COLUMN IF NOT EXISTS.
  try {
    const { readFileSync } = await import('fs');
    const sql = readFileSync(join(__dirname, 'scripts', 'migrations', 'add-gold-columns.sql'), 'utf8');
    await query(sql);
    console.log('[columns] add-gold-columns.sql aplicat (idempotent)');
  } catch (e) {
    console.error('[columns] ensureColumns (gold):', e.message);
  }
  // [WC] standings: cheie unică group-aware (echipa poate fi în grupă ȘI în „third-placed").
  // Drop constraint vechi + dedup + unique index nou. Idempotent.
  try {
    const { readFileSync } = await import('fs');
    const sql = readFileSync(join(__dirname, 'scripts', 'migrations', 'fix-standings-group-unique.sql'), 'utf8');
    await query(sql);
    console.log('[columns] fix-standings-group-unique.sql aplicat (idempotent)');
  } catch (e) {
    console.error('[columns] ensureColumns (standings-group):', e.message);
  }
  // [ARHIVARE] live_stats.created_at (idempotent) — măsurarea acumulării în timp.
  try {
    const { readFileSync } = await import('fs');
    const sql = readFileSync(join(__dirname, 'scripts', 'migrations', 'add-live-stats-created.sql'), 'utf8');
    await query(sql);
    console.log('[columns] add-live-stats-created.sql aplicat (idempotent)');
  } catch (e) {
    console.error('[columns] ensureColumns (live-stats-created):', e.message);
  }
}

const httpServer = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`AlohaScan pornit pe http://0.0.0.0:${PORT}`);
  await initBackfillProgress();
  await resumeOnStartup();
  startScanner();
  ensureIndexes();
  ensureColumns();
  ensureCronLogColumns();   // coloana items_processed pt logging-ul cron uniform
  loadModelWeights().catch(e => console.error('[weights] initial load failed:', e.message));
});

// Crash silentios frecvent = portul deja ocupat (alt proces / dublu process manager).
// Fără acest handler, EADDRINUSE arunca o eroare care oprea procesul fără log util.
httpServer.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[FATAL] Portul ${PORT} este deja ocupat (EADDRINUSE) — ies cu cod 1 ca PM2 să repornească curat (evită proces zombie fără listener → 502).`);
    process.exit(1);
  } else {
    console.error('[FATAL] httpServer error:', err && err.stack ? err.stack : err);
    process.exit(1);
  }
});

const wss = new WebSocketServer({
  server: httpServer,
  perMessageDeflate: {
    zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
    zlibInflateOptions: { chunkSize: 10 * 1024 },
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 10,
    concurrencyLimit: 10,
    threshold: 1024,
  },
});

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
  if (global.lastLiveData) {
    ws.send(JSON.stringify({ type: 'LIVE_UPDATE', payload: global.lastLiveData }));
  }
});

wss.on('close', () => clearInterval(heartbeatInterval));

global.wsBroadcast = function (type, payload) {
  if (wss.clients.size === 0) return;
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
};
