import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
  'elo', 'monte-carlo', 'match-momentum'
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
const cronFiles = ['scan', 'collect-daily', 'collect-finished'];
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

// SPA fallback — toate rutele necunoscute servesc index.html
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AlohaScan pornit pe http://0.0.0.0:${PORT}`);
});
