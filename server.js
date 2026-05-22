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

// API routes — mapate direct la handler-ele Vercel
const apiFiles = [
  'football', 'today', 'enrich', 'match', 'players',
  'agent', 'update-results', 'health-check', 'simulate',
  'elo', 'monte-carlo', 'match-momentum', 'db-stats', 'generator',
  'standings-data', 'venue-weather'
];

for (const name of apiFiles) {
  app.all(`/api/${name}`, async (req, res) => {
    try {
      const mod = await import(`./api/${name}.js`);
      await mod.default(req, res);
    } catch (e) {
      console.error(`[${name}]`, e.message);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });
}

// Cron routes
const cronFiles = ['scan', 'collect-daily', 'collect-finished', 'prematch-enrichment', 'league-stats', 'referee-stats', 'learning-analysis'];
for (const name of cronFiles) {
  app.all(`/api/cron/${name}`, async (req, res) => {
    try {
      const mod = await import(`./api/cron/${name}.js`);
      await mod.default(req, res);
    } catch (e) {
      console.error(`[cron/${name}]`, e.message);
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
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/backfill/stop', async (req, res) => {
  try {
    const result = await stopBackfill();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/backfill/status', async (req, res) => {
  try {
    const result = await getBackfillStatus();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SPA fallback — toate rutele necunoscute servesc index.html
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

const httpServer = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`AlohaScan pornit pe http://0.0.0.0:${PORT}`);
  await initBackfillProgress();
  await resumeOnStartup();
  startScanner();
  loadModelWeights().catch(e => console.error('[weights] initial load failed:', e.message));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  if (global.lastLiveData) {
    ws.send(JSON.stringify({ type: 'LIVE_UPDATE', payload: global.lastLiveData }));
  }
  ws.on('error', () => {});
});

global.wsBroadcast = function (type, payload) {
  if (wss.clients.size === 0) return;
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
};
