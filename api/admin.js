// api/admin.js — Admin API Router
// Toate endpoint-urile sunt protejate cu X-Api-Key header

import express      from 'express';
import { query }    from './db.js';

const router = express.Router();

// ── In-memory rate limiter + IP blocker ─────────────────────────────────────
const rateMap    = new Map(); // IP → { count, resetAt }
const failedMap  = new Map(); // IP → { count, blockedUntil }
const accessLog  = [];        // circular buffer, max 200 entries

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

function isBlocked(ip) {
  const e = failedMap.get(ip);
  if (!e) return false;
  if (Date.now() < e.blockedUntil) return true;
  failedMap.delete(ip);
  return false;
}

function recordFail(ip) {
  const e = failedMap.get(ip) || { count: 0, blockedUntil: 0 };
  e.count++;
  if (e.count >= 5) e.blockedUntil = Date.now() + 3_600_000;
  failedMap.set(ip, e);
}

function recordSuccess(ip) { failedMap.delete(ip); }

function checkRateLimit(ip) {
  const now = Date.now();
  const e   = rateMap.get(ip);
  if (!e || now > e.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (e.count >= 60) return false;
  e.count++;
  return true;
}

function logAccess(ip, method, path, status) {
  accessLog.push({ ts: new Date().toISOString(), ip, method, path, status });
  if (accessLog.length > 200) accessLog.shift();
}

// ── Auth + rate-limit middleware ─────────────────────────────────────────────
router.use((req, res, next) => {
  const ip = getClientIP(req);

  if (isBlocked(ip)) {
    logAccess(ip, req.method, req.path, 403);
    return res.status(403).json({ error: 'IP blocat temporar' });
  }

  if (!checkRateLimit(ip)) {
    logAccess(ip, req.method, req.path, 429);
    return res.status(429).json({ error: 'Rate limit depășit (60 req/min)' });
  }

  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    recordFail(ip);
    const e = failedMap.get(ip);
    logAccess(ip, req.method, req.path, 401);
    const envKey = process.env.ADMIN_API_KEY;
    return res.status(401).json({
      error: 'Unauthorized',
      attempts_left: Math.max(0, 5 - (e?.count || 0)),
      _dbg: {
        env_key_loaded: !!envKey,
        env_key_len: envKey?.length ?? 0,
        env_key_prefix: envKey ? envKey.slice(0, 8) : null,
        recv_key_len: key?.length ?? 0,
        recv_key_prefix: key ? key.slice(0, 8) : null,
      },
    });
  }

  recordSuccess(ip);
  logAccess(ip, req.method, req.path, 200);
  next();
});

// ── GET /api/admin/status ────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    await query('SELECT 1');
    const dbOk = true;
    res.json({
      ok:         true,
      node:       process.version,
      uptime_s:   Math.round(process.uptime()),
      uptime_h:   (process.uptime() / 3600).toFixed(1),
      memory_mb:  Math.round(process.memoryUsage().heapUsed / 1_048_576),
      db:         dbOk ? 'OK' : 'ERROR',
      env_keys:   ['API_FOOTBALL_KEY','POSTGRES_URL','ANTHROPIC_API_KEY','ADMIN_API_KEY']
                    .map(k => ({ key: k, set: !!process.env[k] })),
      ts:         new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/db-stats ──────────────────────────────────────────────────
router.get('/db-stats', async (req, res) => {
  const safe = q => query(q).catch(() => ({ rows: [{ cnt: 0 }] }));
  try {
    const [fh, ls, rs, ms, h2h, st, pred, ps, snaps] = await Promise.all([
      safe('SELECT COUNT(*) AS cnt FROM fixtures_history'),
      safe('SELECT COUNT(*) AS cnt FROM league_stats'),
      safe('SELECT COUNT(*) AS cnt FROM referee_stats'),
      safe('SELECT COUNT(*) AS cnt FROM match_stats'),
      safe('SELECT COUNT(*) AS cnt FROM h2h'),
      safe('SELECT COUNT(*) AS cnt FROM standings'),
      safe('SELECT COUNT(*) AS cnt FROM predictions'),
      safe('SELECT COUNT(*) AS cnt FROM player_stats'),
      safe("SELECT COUNT(*) AS cnt FROM match_snapshots WHERE outcome='LIVE'"),
    ]);
    res.json({
      ok: true,
      tables: {
        fixtures_history: Number(fh.rows[0].cnt),
        league_stats:     Number(ls.rows[0].cnt),
        referee_stats:    Number(rs.rows[0].cnt),
        match_stats:      Number(ms.rows[0].cnt),
        h2h:              Number(h2h.rows[0].cnt),
        standings:        Number(st.rows[0].cnt),
        predictions:      Number(pred.rows[0].cnt),
        player_stats:     Number(ps.rows[0].cnt),
        live_snapshots:   Number(snaps.rows[0].cnt),
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/api-usage ─────────────────────────────────────────────────
router.get('/api-usage', async (req, res) => {
  const key = process.env.FOOTBALL_API_KEY || process.env.API_FOOTBALL_KEY || '';
  try {
    const r    = await fetch('https://v3.football.api-sports.io/status', {
      headers: { 'x-apisports-key': key },
    });
    const data = await r.json();
    const sub  = data.response?.subscription || {};
    const reqs = data.response?.requests     || {};

    const { rows: errRows } = await query(
      `SELECT job_name, ran_at, error_msg
       FROM cron_logs
       WHERE error_msg IS NOT NULL
       ORDER BY ran_at DESC
       LIMIT 10`
    ).catch(() => ({ rows: [] }));

    res.json({
      ok:           true,
      plan:         sub.plan   || '?',
      plan_end:     sub.end    || '?',
      requests_today: Number(reqs.current || 0),
      limit_day:    Number(reqs.limit_day || 100_000),
      remaining:    Number(reqs.limit_day || 100_000) - Number(reqs.current || 0),
      pct_used:     reqs.limit_day
        ? Math.round(reqs.current / reqs.limit_day * 100)
        : 0,
      recent_errors: errRows,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/live-matches ──────────────────────────────────────────────
router.get('/live-matches', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT fixture_id, league_id, home_team, away_team,
             status_short, minute, home_goals, away_goals,
             ng, over15, outcome
      FROM match_snapshots
      WHERE outcome = 'LIVE'
         OR status_short IN ('1H','2H','HT','ET','BT','P','INT')
      ORDER BY minute DESC NULLS LAST
    `).catch(() => ({ rows: [] }));
    res.json({ ok: true, count: rows.length, matches: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/cron-status ───────────────────────────────────────────────
router.get('/cron-status', async (req, res) => {
  const jobs = [
    'league-stats', 'referee-stats', 'collect-daily',
    'collect-finished', 'prematch-enrichment', 'scan',
  ];
  try {
    const { rows } = await query(`
      SELECT DISTINCT ON (job_name)
             job_name, ran_at, status,
             fixtures_processed, players_upserted, error_msg
      FROM cron_logs
      ORDER BY job_name, ran_at DESC
    `).catch(() => ({ rows: [] }));

    const statusMap = Object.fromEntries(rows.map(r => [r.job_name, r]));
    const result = jobs.map(job => ({
      job,
      last_run:           statusMap[job]?.ran_at  || null,
      status:             statusMap[job]?.status  || 'never',
      fixtures_processed: statusMap[job]?.fixtures_processed || 0,
      error_msg:          statusMap[job]?.error_msg || null,
    }));

    res.json({ ok: true, jobs: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/errors ────────────────────────────────────────────────────
router.get('/errors', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT job_name, ran_at, status, error_msg, fixtures_processed
      FROM cron_logs
      WHERE error_msg IS NOT NULL OR status = 'error'
      ORDER BY ran_at DESC
      LIMIT 50
    `).catch(() => ({ rows: [] }));
    res.json({ ok: true, count: rows.length, errors: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/admin/trigger-cron ─────────────────────────────────────────────
const ALLOWED_JOBS = {
  'league-stats':       '/api/cron/league-stats',
  'referee-stats':      '/api/cron/referee-stats',
  'collect-daily':      '/api/cron/collect-daily',
  'collect-finished':   '/api/cron/collect-finished',
  'prematch-enrichment':'/api/cron/prematch-enrichment',
  'backfill':           '/api/backfill/start',
};

router.post('/trigger-cron', async (req, res) => {
  const { job } = req.body || {};
  if (!job || !ALLOWED_JOBS[job]) {
    return res.status(400).json({
      error: 'Job invalid',
      available: Object.keys(ALLOWED_JOBS),
    });
  }
  const port = process.env.PORT || 3000;
  const url  = `http://localhost:${port}${ALLOWED_JOBS[job]}`;
  try {
    // Fire-and-forget — răspuns imediat
    fetch(url).catch(() => {});
    res.json({ ok: true, job, url, triggered_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/access-log ────────────────────────────────────────────────
router.get('/access-log', (req, res) => {
  res.json({ ok: true, entries: [...accessLog].reverse().slice(0, 50) });
});

export default router;
