import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { query } from './api/db.js';
import { runDailyBackfill, initBackfillProgress } from './api/backfill.js';
import { startScanner } from './api/cron/scanner.js';
import adminRouter from './api/admin.js';

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
  'elo', 'monte-carlo', 'match-momentum', 'db-stats'
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
const cronFiles = ['scan', 'collect-daily', 'collect-finished', 'prematch-enrichment', 'league-stats', 'referee-stats'];
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

// Health / debug (public, fără auth)
app.get('/health', (req, res) => {
  const k = process.env.ADMIN_API_KEY || '';
  res.json({
    ok: true,
    cwd: process.cwd(),
    admin_key_loaded: k.length > 0,
    admin_key_len: k.length,
    admin_key_prefix: k ? k.slice(0, 8) : null,
  });
});

// Backfill routes
app.get('/api/backfill/start', async (req, res) => {
  runDailyBackfill(); // async, fără await — rulează în background
  res.json({ status: 'started' });
});

app.get('/api/backfill/status', async (req, res) => {
  try {
    const result = await query(
      'SELECT status, COUNT(*) AS count FROM backfill_progress GROUP BY status ORDER BY status'
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SPA fallback — toate rutele necunoscute servesc index.html
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`AlohaScan pornit pe http://0.0.0.0:${PORT}`);
  await initBackfillProgress();
  startScanner();
});
