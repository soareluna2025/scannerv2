import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';

process.on('uncaughtException', (err) => {
  console.error('[crash] uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[crash] unhandledRejection:', reason);
});
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
  'calibration', 'bets', 'debug-live', 'matches-history'
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
const cronFiles = ['scan', 'collect-daily', 'collect-finished', 'prematch-enrichment', 'league-stats', 'referee-stats', 'learning-analysis', 'recalibrate-tables', 'calibrate-live', 'collect-venues', 'collect-coaches', 'coach-stats', 'referee-extended', 'collect-team-stats', 'collect-top-scorers', 'collect-players-season', 'collect-squads', 'cazarma-router', 'auto-predict', 'backfill-pass-shots'];
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
    const result = await startBackfill();
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

const httpServer = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`AlohaScan pornit pe http://0.0.0.0:${PORT}`);
  await initBackfillProgress();
  await resumeOnStartup();
  startScanner();
  ensureIndexes();
  loadModelWeights().catch(e => console.error('[weights] initial load failed:', e.message));
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
