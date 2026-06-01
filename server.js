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
import { query } from './api/db.js';
import { initBackfillProgress, startBackfill, stopBackfill, getBackfillStatus, resumeOnStartup } from './api/backfill.js';
import { startScanner } from './api/cron/scanner.js';
import adminRouter from './api/admin.js';
import { loadModelWeights } from './api/weights.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files (index.html, icons, manifest, service-worker)
app.use(express.static(__dirname, { index: 'index.html' }));
// Public static (CSS extras, future JS modules)
app.use(express.static(join(__dirname, 'public')));

// API routes — mapate direct la handler-ele Vercel
import { logError } from './api/db.js';

const apiFiles = [
  'football', 'today', 'enrich', 'match', 'players',
  'agent', 'update-results', 'health-check', 'simulate',
  'elo', 'monte-carlo', 'match-momentum', 'db-stats', 'generator',
  'standings-data', 'venue-weather', 'backfill-stats', 'learning-leagues',
  'calibration', 'bets', 'debug-live', 'matches-history', 'model-accuracy', 'team'
];

for (const name of apiFiles) {
  app.all(`/api/${name}`, async (req, res) => {
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
const cronFiles = ['scan', 'collect-daily', 'collect-finished', 'prematch-enrichment', 'league-stats', 'referee-stats', 'learning-analysis', 'recalibrate-tables', 'calibrate-live', 'collect-venues', 'collect-coaches', 'coach-stats', 'referee-extended', 'collect-team-stats', 'collect-top-scorers', 'collect-players-season', 'collect-squads', 'cazarma-router', 'auto-predict', 'backfill-pass-shots', 'backfill-players'];
for (const name of cronFiles) {
  app.all(`/api/cron/${name}`, async (req, res) => {
    try {  // catch-block jos logheaza in cron_logs
      const mod = await import(`./api/cron/${name}.js`);
      await mod.default(req, res);
    } catch (e) {
      console.error(`[cron/${name}]`, e.message);
      logError(`cron-${name}`, e.message);  // vizibil in admin -> Erori Recente
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
  try {
    const result = await stopBackfill();
    res.json(result);
  } catch (e) {
    logError('backfill', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/backfill/status', async (req, res) => {
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
}

const httpServer = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`AlohaScan pornit pe http://0.0.0.0:${PORT}`);
  await initBackfillProgress();
  await resumeOnStartup();
  startScanner();
  ensureIndexes();
  ensureColumns();
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
