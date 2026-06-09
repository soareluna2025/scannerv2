// api/admin.js — Admin API Router
// Toate endpoint-urile sunt protejate cu X-Api-Key header

import express      from 'express';
import http         from 'node:http';
import { query }    from './db.js';
import { getScannerPaused, setScannerPaused } from './cron/scanner.js';
import { fetchApiFootball } from './utils/fetch-api.js';

// Apel HTTP local cu timeout EFECTIV pe inactivitate (node:http), NU fetch global
// (undici) — care are headersTimeout implicit de 300s și ar aborta pașii lungi
// (train-model/train-live) la ~5 min, ignorând timeoutMs. Întoarce {ok,status}.
function _stabilizeHttp(urlStr, method, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        res.resume();   // drenează corpul → eliberează socketul
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
        res.on('error', reject);
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout după ${Math.round(timeoutMs / 60000)} min`)));
    req.on('error', reject);
    req.end();
  });
}

const router = express.Router();

// Cache /status 10 min — evită consum de call API la fiecare refresh admin.
let _apiStatusCache = null;
let _apiStatusCacheTs = 0;
const API_STATUS_TTL = 10 * 60 * 1000;

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

  const key    = (req.headers['x-api-key'] || '').trim();
  const envKey = (process.env.ADMIN_API_KEY || '').trim();
  if (!key || !envKey || key !== envKey) {
    recordFail(ip);
    const e = failedMap.get(ip);
    logAccess(ip, req.method, req.path, 401);
    return res.status(401).json({
      error: 'Unauthorized',
      attempts_left: Math.max(0, 5 - (e?.count || 0)),
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
    const [fh, ls, rs, ms, h2h, st, pred, ps, snaps, psSeason, topSc, sq] = await Promise.all([
      safe('SELECT COUNT(*) AS cnt FROM fixtures_history'),
      safe('SELECT COUNT(*) AS cnt FROM league_stats'),
      safe('SELECT COUNT(*) AS cnt FROM referee_stats'),
      safe('SELECT COUNT(*) AS cnt FROM match_stats'),
      safe('SELECT COUNT(*) AS cnt FROM h2h'),
      safe('SELECT COUNT(*) AS cnt FROM standings'),
      safe('SELECT COUNT(*) AS cnt FROM predictions'),
      safe('SELECT COUNT(*) AS cnt FROM player_stats'),
      safe("SELECT COUNT(*) AS cnt FROM match_snapshots WHERE outcome='LIVE'"),
      safe('SELECT COUNT(*) AS cnt FROM players_season'),
      safe('SELECT COUNT(*) AS cnt FROM top_scorers'),
      safe('SELECT COUNT(*) AS cnt FROM squads'),
    ]);
    // pre_match_snapshots accuracy
    const pmsTotal = await safe('SELECT COUNT(*) AS cnt FROM pre_match_snapshots');
    const pmsWins  = await safe("SELECT COUNT(*) AS cnt FROM pre_match_snapshots WHERE outcome='WIN'");
    const pmsResolved = await safe("SELECT COUNT(*) AS cnt FROM pre_match_snapshots WHERE outcome IS NOT NULL");

    res.json({
      ok: true,
      tables: {
        fixtures_history:     Number(fh.rows[0].cnt),
        league_stats:         Number(ls.rows[0].cnt),
        referee_stats:        Number(rs.rows[0].cnt),
        match_stats:          Number(ms.rows[0].cnt),
        h2h:                  Number(h2h.rows[0].cnt),
        standings:            Number(st.rows[0].cnt),
        predictions:          Number(pred.rows[0].cnt),
        player_stats:         Number(ps.rows[0].cnt),
        live_snapshots:       Number(snaps.rows[0].cnt),
        pre_match_snapshots:  Number(pmsTotal.rows[0].cnt),
        players_season:       Number(psSeason.rows[0].cnt),
        top_scorers:          Number(topSc.rows[0].cnt),
        squads:               Number(sq.rows[0].cnt),
      },
      prediction_accuracy: {
        resolved: Number(pmsResolved.rows[0].cnt),
        wins:     Number(pmsWins.rows[0].cnt),
        accuracy_pct: Number(pmsResolved.rows[0].cnt) > 0
          ? Math.round(Number(pmsWins.rows[0].cnt) / Number(pmsResolved.rows[0].cnt) * 100)
          : null,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/api-usage ─────────────────────────────────────────────────
router.get('/api-usage', async (req, res) => {
  // Cheia corectă din .env pe VPS = API_FOOTBALL_KEY (prima în lanț, aliniat cu restul app).
  const key = process.env.API_FOOTBALL_KEY || process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || '';
  const DEFAULT_LIMIT = 300_000; // plan Custom300 — fallback când API nu raportează limita

  // recent_errors din cron_logs (independent de starea /status)
  const { rows: errRows } = await query(
    `SELECT job_name, ran_at, error_msg
     FROM cron_logs
     WHERE error_msg IS NOT NULL
     ORDER BY ran_at DESC
     LIMIT 10`
  ).catch(() => ({ rows: [] }));

  // Cache 10 min pe rezultatul /status
  if (_apiStatusCache && Date.now() - _apiStatusCacheTs < API_STATUS_TTL) {
    return res.json({ ..._apiStatusCache, recent_errors: errRows, cached: true });
  }

  try {
    const r    = await fetch('https://v3.football.api-sports.io/status', {
      headers: { 'x-apisports-key': key },
    });
    const data = await r.json();
    const sub  = data.response?.subscription || {};
    const reqs = data.response?.requests     || {};

    // Detectează răspuns gol/eroare: response lipsește SAU API a întors errors.
    const apiErrors = data.errors && (Array.isArray(data.errors) ? data.errors.length : Object.keys(data.errors).length);
    const statusUnavailable = !data.response || apiErrors;
    if (statusUnavailable) {
      const msg = apiErrors ? JSON.stringify(data.errors) : 'response gol';
      console.error('[admin/api-usage] /status indisponibil:', msg);
      // NU cache-uim un răspuns degradat → reîncearcă la următorul refresh.
      return res.json({
        ok:            false,
        status_msg:    'API status indisponibil',
        plan:          'API status indisponibil',
        plan_end:      'API status indisponibil',
        requests_today: 0,
        limit_day:     DEFAULT_LIMIT,
        remaining:     DEFAULT_LIMIT,
        pct_used:      0,
        recent_errors: errRows,
      });
    }

    const limitDay = Number(reqs.limit_day) || DEFAULT_LIMIT;
    const current  = Number(reqs.current) || 0;
    const payload = {
      ok:           true,
      plan:         sub.plan || '?',
      plan_end:     sub.end  || '?',
      requests_today: current,
      limit_day:    limitDay,
      remaining:    Math.max(0, limitDay - current),
      pct_used:     limitDay ? Math.round(current / limitDay * 100) : 0,
    };
    _apiStatusCache   = payload;
    _apiStatusCacheTs = Date.now();
    res.json({ ...payload, recent_errors: errRows, cached: false });
  } catch (e) {
    console.error('[admin/api-usage] fetch /status error:', e.message);
    res.json({
      ok:            false,
      status_msg:    'API status indisponibil',
      plan:          'API status indisponibil',
      plan_end:      'API status indisponibil',
      requests_today: 0,
      limit_day:     DEFAULT_LIMIT,
      remaining:     DEFAULT_LIMIT,
      pct_used:      0,
      recent_errors: errRows,
      error:         e.message,
    });
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
      WHERE (outcome = 'LIVE' OR status_short IN ('1H','2H','HT','ET','BT','P','INT'))
        AND created_at > NOW() - INTERVAL '6 hours'
      ORDER BY minute DESC NULLS LAST
      LIMIT 50
    `).catch(() => ({ rows: [] }));
    res.json({ ok: true, count: rows.length, matches: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/cron-status ───────────────────────────────────────────────
router.get('/cron-status', async (req, res) => {
  const jobs = [
    'auto-predict', 'update-results', 'learning-analysis',
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

// ── GET /api/admin/team-search?q=<nume> ──────────────────────────────────────
// Căutare echipă după nume (API-Football /teams?search=) — pt cardul EXTRAGERE ECHIPĂ.
router.get('/team-search', async (req, res) => {
  const q = (req.query?.q || '').trim();
  if (q.length < 2) return res.status(200).json({ ok: true, results: [] });
  try {
    const r = await fetchApiFootball(`/teams?search=${encodeURIComponent(q)}`);
    const d = await r.json();
    const results = (d.response || []).slice(0, 10).map(x => ({
      id:      x.team?.id,
      name:    x.team?.name,
      country: x.team?.country || null,
      logo:    x.team?.logo || null,
    })).filter(t => t.id);
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/team-season?team_id=<id> ──────────────────────────────────
// Detectează sezonul-ancoră al echipei din API (NU ghicit cu logica europeană):
//   1) max(year) dintre sezoanele cu current===true; 2) altfel max(year); 3) null.
router.get('/team-season', async (req, res) => {
  const teamId = Number(req.query?.team_id);
  if (!teamId) return res.status(400).json({ ok: false, error: 'team_id required' });
  try {
    const r = await fetchApiFootball(`/leagues?team=${teamId}`);
    const d = await r.json();
    let curMax = null, anyMax = null;
    for (const lg of (d.response || [])) {
      for (const s of (lg.seasons || [])) {
        const y = Number(s.year);
        if (!Number.isFinite(y)) continue;
        if (anyMax == null || y > anyMax) anyMax = y;
        if (s.current === true && (curMax == null || y > curMax)) curMax = y;
      }
    }
    res.json({ ok: true, season: curMax != null ? curMax : (anyMax != null ? anyMax : null) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, season: null });
  }
});

// ── GET /api/admin/errors ────────────────────────────────────────────────────
// Default: ultimele 14 zile. Opt: ?days=N (1-90) | ?all=1 (toate)
router.get('/errors', async (req, res) => {
  try {
    const showAll = req.query?.all === '1';
    const days = Math.min(Math.max(parseInt(req.query?.days || '14', 10), 1), 90);
    let whereDate = showAll ? '' : `AND ran_at > NOW() - INTERVAL '${days} days'`;
    const { rows } = await query(`
      SELECT id, job_name, ran_at, status, error_msg, fixtures_processed
      FROM cron_logs
      WHERE (error_msg IS NOT NULL OR status = 'error') ${whereDate}
      ORDER BY ran_at DESC
      LIMIT 100
    `).catch(() => ({ rows: [] }));
    // Numar total fara filtru
    const { rows: totalRows } = await query(`
      SELECT COUNT(*)::int AS n
      FROM cron_logs
      WHERE error_msg IS NOT NULL OR status = 'error'
    `).catch(() => ({ rows: [{ n: 0 }] }));
    res.json({
      ok: true,
      count: rows.length,
      total_all_time: totalRows[0]?.n || 0,
      filter: showAll ? 'all' : `last_${days}_days`,
      errors: rows,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── DELETE /api/admin/clear-errors ───────────────────────────────────────────
// Sterge erori din cron_logs. Optiuni:
//   ?days=N      - sterge erori MAI VECHI decat N zile (recomandare: 7)
//   ?job=NAME    - sterge erori doar pentru un anumit job
//   ?all=1       - sterge TOATE (atentie: ireversibil)
router.delete('/clear-errors', async (req, res) => {
  try {
    const all = req.query?.all === '1';
    const days = parseInt(req.query?.days || '0', 10);
    const job = req.query?.job;
    let sql, params = [];
    if (all) {
      sql = `DELETE FROM cron_logs WHERE error_msg IS NOT NULL OR status = 'error'`;
    } else if (job) {
      sql = `DELETE FROM cron_logs WHERE job_name = $1 AND (error_msg IS NOT NULL OR status = 'error')`;
      params = [job];
    } else if (days > 0) {
      sql = `DELETE FROM cron_logs WHERE (error_msg IS NOT NULL OR status = 'error') AND ran_at < NOW() - INTERVAL '${days} days'`;
    } else {
      return res.status(400).json({ ok: false, error: 'Specifica ?days=N sau ?job=NAME sau ?all=1' });
    }
    const result = await query(sql, params);
    res.json({
      ok: true,
      deleted: result.rowCount || 0,
      filter: all ? 'all' : job ? `job=${job}` : `older_than_${days}_days`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/admin/trigger-cron ─────────────────────────────────────────────
const ALLOWED_JOBS = {
  'auto-predict':       '/api/cron/auto-predict',
  'update-results':     '/api/update-results',
  'learning-analysis':  '/api/cron/learning-analysis',
  'league-stats':       '/api/cron/league-stats',
  'referee-stats':      '/api/cron/referee-stats',
  'collect-daily':      '/api/cron/collect-daily',
  'collect-finished':   '/api/cron/collect-finished',
  'prematch-enrichment':'/api/cron/prematch-enrichment',
  'scan':               '/api/cron/scan',
  'backfill':           '/api/backfill/start',
  'recalibrate-tables': '/api/cron/recalibrate-tables',
  'calibrate-live':     '/api/cron/calibrate-live',
  'collect-venues':     '/api/cron/collect-venues',
  'collect-coaches':    '/api/cron/collect-coaches',
  'coach-stats':        '/api/cron/coach-stats',
  'referee-extended':   '/api/cron/referee-extended',
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
    // Fire-and-forget — răspuns imediat (POST pentru compatibilitate cu toate cron-urile)
    fetch(url, {
      method: 'POST',
      headers: {
        'x-cron-secret': process.env.CRON_SECRET || '',
      },
    }).catch(() => {});
    res.json({ ok: true, job, url, triggered_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/admin/stabilize — rulează cele STABILIZE_STEPS.length cron-uri SECVENȚIAL ──
// Ordine: brut → agregat → predicții → calibrare. Fiecare AȘTEAPTĂ finalizarea
// celui anterior. Un pas eșuat NU oprește lanțul (continuă). Progres în memorie.
const STABILIZE_STEPS = [
  { name: 'collect-finished',   path: '/api/cron/collect-finished' },
  { name: 'collect-squads',     path: '/api/cron/collect-squads' },
  { name: 'collect-coaches',    path: '/api/cron/collect-coaches' },
  { name: 'collect-venues',     path: '/api/cron/collect-venues' },
  { name: 'collect-daily',      path: '/api/cron/collect-daily' },
  { name: 'league-stats',       path: '/api/cron/league-stats' },
  { name: 'referee-stats',      path: '/api/cron/referee-stats' },
  { name: 'referee-extended',   path: '/api/cron/referee-extended' },
  { name: 'coach-stats',        path: '/api/cron/coach-stats' },
  { name: 'update-results',     path: '/api/update-results' },
  // Feature store + antrenare ML (timeout 20 min — train_*.py durează).
  { name: 'build-ml-features',          path: '/api/cron/build-ml-features', timeoutMs: 20 * 60 * 1000 },
  { name: 'train-model (ML pre-meci)',  path: '/api/cron/train-model',       timeoutMs: 20 * 60 * 1000 },
  { name: 'train-live (ML live)',       path: '/api/cron/train-live',        timeoutMs: 20 * 60 * 1000 },
  { name: 'learning-analysis',  path: '/api/cron/learning-analysis' },
  { name: 'recalibrate-tables', path: '/api/cron/recalibrate-tables' },
  { name: 'calibrate-live',     path: '/api/cron/calibrate-live' },
  // Pasul 14 — auto-predict: după ce datele sunt proaspete, generează predicții.
  // Apelat via GET (cron-ul e GET /api/cron/auto-predict). Timeout 15 min (poate dura
  // mai mult — predicții pt toate meciurile NS).
  { name: 'auto-predict',       path: '/api/cron/auto-predict', method: 'GET' },
];

// Stare partajată (un singur run global) — citită de /stabilize-status.
let _stabilize = { running: false, currentStep: 0, total: STABILIZE_STEPS.length,
  currentName: null, startedAt: null, finishedAt: null, steps: [] };

async function runStabilize() {
  const port = process.env.PORT || 3000;
  globalThis._stabilizeActive = true; // flag citit de backfill → reduce concurența DB
  _stabilize = { running: true, currentStep: 0, total: STABILIZE_STEPS.length,
    currentName: null, startedAt: Date.now(), finishedAt: null, steps: [] };
  for (let i = 0; i < STABILIZE_STEPS.length; i++) {
    const step = STABILIZE_STEPS[i];
    _stabilize.currentStep = i + 1;
    _stabilize.currentName = step.name;
    const t0 = Date.now();
    let ok = false, errMsg = null;
    try {
      const r = await _stabilizeHttp(
        `http://localhost:${port}${step.path}`,
        step.method || 'POST',                          // default POST; auto-predict = GET
        { 'x-cron-secret': process.env.CRON_SECRET || '' },
        step.timeoutMs || 15 * 60 * 1000                // 15 min/pas; 20 min pt ML (efectiv)
      );
      ok = r.ok;
      if (!r.ok) errMsg = `HTTP ${r.status}`;
    } catch (e) {
      errMsg = e.message;
    }
    const durMs = Date.now() - t0;
    _stabilize.steps.push({ step: i + 1, name: step.name, ok, error: errMsg, durMs });
    console.log(`[stabilize] Pas ${i + 1}/${STABILIZE_STEPS.length}: ${step.name} → ${ok ? 'OK' : 'EROARE ' + errMsg} (${Math.round(durMs / 1000)}s)`);
    // continuă chiar dacă pasul a eșuat
  }
  _stabilize.running = false;
  _stabilize.finishedAt = Date.now();
  _stabilize.currentName = null;
  globalThis._stabilizeActive = false;
}

router.post('/stabilize', async (req, res) => {
  if (_stabilize.running) {
    return res.status(409).json({ ok: false, error: 'Stabilizare deja în curs', progress: _stabilize });
  }
  runStabilize().catch(e => { console.error('[stabilize] fatal:', e.message); _stabilize.running = false; });
  res.json({ ok: true, started: true, total: STABILIZE_STEPS.length });
});

router.get('/stabilize-status', async (req, res) => {
  const totalMs = _stabilize.startedAt
    ? (_stabilize.finishedAt || Date.now()) - _stabilize.startedAt
    : 0;
  res.json({ ...(_stabilize), totalMs });
});

// ── GET /api/admin/prediction-accuracy ──────────────────────────────────────
router.get('/prediction-accuracy', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE outcome = 'WIN')           AS wins,
        COUNT(*) FILTER (WHERE outcome = 'LOSS')          AS losses,
        COUNT(*) FILTER (WHERE outcome IS NOT NULL)       AS resolved,
        COUNT(*)                                          AS total,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE outcome = 'WIN')
          / NULLIF(COUNT(*) FILTER (WHERE outcome IS NOT NULL), 0), 1
        ) AS accuracy_pct
      FROM (
        SELECT outcome FROM pre_match_snapshots
        WHERE outcome IS NOT NULL
        ORDER BY created_at DESC LIMIT 100
      ) recent
    `).catch(() => ({ rows: [] }));

    const row = rows[0] || {};
    res.json({
      ok:           true,
      accuracy_pct: row.accuracy_pct ? Number(row.accuracy_pct) : null,
      wins:         Number(row.wins   || 0),
      losses:       Number(row.losses || 0),
      sample:       Number(row.resolved || 0),
      total_snapshots: Number(row.total || 0),
      note: 'WIN = over15_prob ≥55% AND actual over15, OR over15_prob <45% AND actual under15. Last 100 resolved.',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/access-log ────────────────────────────────────────────────
router.get('/access-log', (req, res) => {
  res.json({ ok: true, entries: [...accessLog].reverse().slice(0, 50) });
});

// ── GET /api/admin/learning-stats ───────────────────────────────────────────
router.get('/learning-stats', async (req, res) => {
  try {
    const safe = q => query(q).catch(() => ({ rows: [] }));

    const [totals, byModule, byLeague, recentWeights] = await Promise.all([
      safe(`SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE outcome!='PENDING') AS resolved,
        COUNT(*) FILTER (WHERE outcome='PENDING') AS pending,
        COUNT(*) FILTER (WHERE outcome='WIN') AS wins,
        ROUND(100.0*COUNT(*) FILTER (WHERE outcome='WIN')/NULLIF(COUNT(*) FILTER (WHERE outcome!='PENDING'),0),1) AS global_win_rate
        FROM prediction_log`),
      safe(`SELECT module,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE outcome!='PENDING') AS resolved,
        COUNT(*) FILTER (WHERE outcome='WIN') AS wins,
        ROUND(100.0*COUNT(*) FILTER (WHERE outcome='WIN')/NULLIF(COUNT(*) FILTER (WHERE outcome!='PENDING'),0),1) AS win_rate,
        MAX(created_at) AS last_prediction
        FROM prediction_log
        GROUP BY module ORDER BY module`),
      safe(`SELECT pl.league_id, pl.league_name,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE pl.outcome='WIN') AS wins,
        ROUND(100.0*COUNT(*) FILTER (WHERE pl.outcome='WIN')/NULLIF(COUNT(*) FILTER (WHERE pl.outcome!='PENDING'),0),1) AS win_rate
        FROM prediction_log pl
        WHERE pl.outcome != 'PENDING' AND pl.league_id IS NOT NULL
        GROUP BY pl.league_id, pl.league_name
        HAVING COUNT(*) >= 10
        ORDER BY win_rate DESC NULLS LAST
        LIMIT 10`),
      safe(`SELECT module, context_key, weight_name, weight_value, default_value, sample_size, win_rate, confidence_level, last_updated
        FROM model_weights
        WHERE last_updated > NOW() - INTERVAL '7 days'
          AND weight_value != default_value
        ORDER BY last_updated DESC LIMIT 20`),
    ]);

    const t = totals.rows[0] || {};
    const mod = byModule.rows.map(r => ({
      module:       r.module,
      total:        Number(r.total),
      resolved:     Number(r.resolved),
      wins:         Number(r.wins),
      win_rate:     r.win_rate ? Number(r.win_rate) : null,
      last_prediction: r.last_prediction,
      trend: r.win_rate > 60 ? 'good' : r.win_rate < 45 ? 'poor' : 'neutral',
    }));

    const globalWR = t.global_win_rate ? Number(t.global_win_rate) : null;
    const confidence = Number(t.resolved) >= 100 ? 'HIGH' : Number(t.resolved) >= 30 ? 'MEDIUM' : 'LOW';

    res.json({
      ok: true,
      total_predictions: Number(t.total || 0),
      resolved:          Number(t.resolved || 0),
      pending:           Number(t.pending || 0),
      wins:              Number(t.wins || 0),
      global_win_rate:   globalWR,
      model_confidence:  confidence,
      by_module:         mod,
      by_league_top10:   byLeague.rows.map(r => ({
        league_id:   Number(r.league_id),
        league_name: r.league_name,
        total:       Number(r.total),
        wins:        Number(r.wins),
        win_rate:    Number(r.win_rate),
      })),
      weights_updated_recently: recentWeights.rows.map(r => ({
        module:       r.module,
        context_key:  r.context_key,
        weight_name:  r.weight_name,
        old_value:    Number(r.default_value),
        new_value:    Number(r.weight_value),
        samples:      Number(r.sample_size),
        win_rate:     r.win_rate ? Number(r.win_rate) : null,
        confidence:   r.confidence_level,
        updated_at:   r.last_updated,
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/win-rate-patterns ─────────────────────────────────────────
// Foloseste tabela 'predictions' (alerte NGP/Over15 stocate de scanner.js):
// fiecare rand are score_at_alert + outcome_ngp (WIN/LOSS/PENDING) + league.
// NU foloseste prediction_log (tabela detaliata cu 7 layers + minute) pentru
// ca poate sa nu existe in toate DB-urile (depinde daca create-tables a fost
// rulat complet la deploy).
router.get('/win-rate-patterns', async (req, res) => {
  const days       = Math.min(parseInt(req.query?.days       || '30',  10), 365);
  const minSamples = Math.max(parseInt(req.query?.minSamples || '5',   10), 1);
  const leagueId   = req.query?.league_id ? parseInt(req.query.league_id, 10) : null;

  const lgClause = leagueId ? ' AND league_id = $2' : '';
  const paramsBase = leagueId ? [days, leagueId] : [days];

  try {
    // 1. Overall counters folosind result_over15 (populat zilnic de /api/update-results)
    // WIN = result_over15 TRUE (Over 1.5 hit), LOSS = FALSE, PENDING = NULL (meci necont. inca)
    const ovSQL = `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE result_over15 = TRUE)::int  AS wins,
        COUNT(*) FILTER (WHERE result_over15 = FALSE)::int AS losses,
        COUNT(*) FILTER (WHERE result_over15 IS NULL)::int AS pending
      FROM predictions
      WHERE created_at > NOW() - (INTERVAL '1 day' * $1)
        ${lgClause}
    `;
    const { rows: ovRows } = await query(ovSQL, paramsBase);
    const ov = ovRows[0] || { total: 0, wins: 0, losses: 0, pending: 0 };
    const ovResolved = Number(ov.wins) + Number(ov.losses);
    const overall = {
      total:    Number(ov.total),
      wins:     Number(ov.wins),
      losses:   Number(ov.losses),
      pending:  Number(ov.pending),
      resolved: ovResolved,
      winRate:  ovResolved > 0 ? +(Number(ov.wins) / ovResolved * 100).toFixed(1) : null,
    };

    // 2. Per over15_prob bucket
    const probSQL = `
      SELECT
        CASE
          WHEN over15_prob < 50 THEN '<50'
          WHEN over15_prob < 60 THEN '50-60'
          WHEN over15_prob < 70 THEN '60-70'
          WHEN over15_prob < 80 THEN '70-80'
          WHEN over15_prob < 90 THEN '80-90'
          ELSE '90+'
        END AS bucket,
        COUNT(*)::int AS n,
        COUNT(*) FILTER (WHERE result_over15 = TRUE)::int AS wins
      FROM predictions
      WHERE created_at > NOW() - (INTERVAL '1 day' * $1)
        AND result_over15 IS NOT NULL
        AND over15_prob IS NOT NULL
        ${lgClause}
      GROUP BY 1
      ORDER BY 1
    `;
    const { rows: probRows } = await query(probSQL, paramsBase);
    const byNgpBucket = probRows
      .filter(r => Number(r.n) >= minSamples)
      .map(r => ({
        range:   r.bucket,
        n:       Number(r.n),
        wins:    Number(r.wins),
        winRate: +(Number(r.wins) / Number(r.n) * 100).toFixed(1),
      }));

    // 3. Per confidence bucket
    const confSQL = `
      SELECT
        CASE
          WHEN confidence < 50 THEN '<50'
          WHEN confidence < 60 THEN '50-60'
          WHEN confidence < 70 THEN '60-70'
          WHEN confidence < 80 THEN '70-80'
          WHEN confidence < 90 THEN '80-90'
          ELSE '90+'
        END AS bucket,
        COUNT(*)::int AS n,
        COUNT(*) FILTER (WHERE result_over15 = TRUE)::int AS wins
      FROM predictions
      WHERE created_at > NOW() - (INTERVAL '1 day' * $1)
        AND result_over15 IS NOT NULL
        AND confidence IS NOT NULL
        ${lgClause}
      GROUP BY 1
      ORDER BY 1
    `;
    const { rows: confRows } = await query(confSQL, paramsBase);
    const byScoreState = confRows
      .filter(r => Number(r.n) >= minSamples)
      .map(r => ({
        state:   'confidence ' + r.bucket,
        n:       Number(r.n),
        wins:    Number(r.wins),
        winRate: +(Number(r.wins) / Number(r.n) * 100).toFixed(1),
      }));

    // 4. Per league
    let byLeague = null;
    if (!leagueId) {
      const lgSQL = `
        SELECT
          league_name AS league,
          league_id,
          COUNT(*)::int AS n,
          COUNT(*) FILTER (WHERE result_over15 = TRUE)::int AS wins,
          ROUND(100.0 * COUNT(*) FILTER (WHERE result_over15 = TRUE) / NULLIF(COUNT(*), 0), 1) AS wr
        FROM predictions
        WHERE created_at > NOW() - (INTERVAL '1 day' * $1)
          AND result_over15 IS NOT NULL
          AND league_name IS NOT NULL
        GROUP BY league_name, league_id
        HAVING COUNT(*) >= ${minSamples}
        ORDER BY wr DESC NULLS LAST
        LIMIT 25
      `;
      const { rows: lgRows } = await query(lgSQL, [days]);
      byLeague = lgRows.map(r => ({
        league:    r.league,
        league_id: r.league_id,
        n:         Number(r.n),
        wins:      Number(r.wins),
        winRate:   r.wr === null ? 0 : Number(r.wr),
      }));
    }

    res.json({
      ok: true,
      meta: { days, source: 'predictions.result_over15', minSamples, leagueId, asOf: new Date().toISOString() },
      overall,
      byNgpBucket,
      byScoreState,
      ...(byLeague ? { byLeague } : {}),
    });
  } catch (e) {
    console.error('[win-rate-patterns]', e.message, e.stack);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/calibration ──────────────────────────────────────────────
// Vizualizare calibrare pre-meci + LIVE din DB (tabela calibration_tables si calibration_live)
router.get('/calibration', async (req, res) => {
  try {
    const { rows: preRows } = await query(`
      SELECT module, buckets, sample_size, brier_score, generated_at
      FROM calibration_tables
      ORDER BY module
    `).catch(() => ({ rows: [] }));

    const { rows: liveRows } = await query(`
      SELECT market, minute_bucket, score_state, n_samples, real_pct, generated_at
      FROM calibration_live
      ORDER BY market, minute_bucket, score_state
    `).catch(() => ({ rows: [] }));

    // Group LIVE by market for summary
    const liveByMarket = {};
    liveRows.forEach(r => {
      if (!liveByMarket[r.market]) liveByMarket[r.market] = { n: 0, buckets: 0, samples: 0, last: null };
      liveByMarket[r.market].buckets++;
      liveByMarket[r.market].samples += Number(r.n_samples);
      if (!liveByMarket[r.market].last || new Date(r.generated_at) > new Date(liveByMarket[r.market].last)) {
        liveByMarket[r.market].last = r.generated_at;
      }
    });

    res.json({
      ok: true,
      pre: preRows.map(r => ({
        module:      r.module,
        sample_size: Number(r.sample_size || 0),
        brier:       r.brier_score ? Number(r.brier_score) : null,
        buckets:     r.buckets,
        updated:     r.generated_at,
      })),
      live: Object.entries(liveByMarket).map(([market, v]) => ({
        market,
        buckets:     v.buckets,
        samples:     v.samples,
        updated:     v.last,
      })),
      live_total: liveRows.length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/leagues-insights ─────────────────────────────────────────
// Analiza per liga: WR pe Over 1.5 din predictions vs baseline, sugestii
router.get('/leagues-insights', async (req, res) => {
  try {
    const baseline = 70;  // baseline expected WR
    // Folosim COALESCE(l.name, p.league_name) pentru leagues lipsa
    let rows = [];
    try {
      const r = await query(`
        SELECT
          p.league_id,
          COALESCE(l.name, p.league_name) AS league_name,
          COALESCE(l.country, '—')        AS country,
          COUNT(*)::int                                                         AS total,
          COUNT(*) FILTER (WHERE p.result_over15 = TRUE)::int                    AS wins,
          COUNT(*) FILTER (WHERE p.result_over15 = FALSE)::int                   AS losses,
          AVG(p.over15_prob)                                                     AS avg_predicted
        FROM predictions p
        LEFT JOIN leagues l ON l.league_id = p.league_id
        WHERE p.result_over15 IS NOT NULL
          AND p.over15_prob >= 70
          AND p.created_at > NOW() - INTERVAL '180 days'
        GROUP BY p.league_id, COALESCE(l.name, p.league_name), COALESCE(l.country, '—')
        HAVING COUNT(*) >= 10
        ORDER BY COUNT(*) DESC
        LIMIT 50
      `);
      rows = r.rows;
    } catch (e) {
      console.warn('[leagues-insights] query failed:', e.message);
    }
    if (!rows.length) {
      return res.json({
        ok: true,
        baseline,
        total_leagues: 0,
        counts: { overperformers: 0, on_target: 0, underperformers: 0 },
        leagues: [],
        message: 'Niciun rezultat — predictions cu result_over15 populat lipsesc sau sample <10 per liga.',
      });
    }

    const insights = rows.map(r => {
      const total = Number(r.total);
      const wins = Number(r.wins);
      const losses = Number(r.losses);
      const resolved = wins + losses;
      const winRate = resolved > 0 ? +(wins / resolved * 100).toFixed(1) : null;
      const avgPred = Number(r.avg_predicted || 0).toFixed(1);
      // Diferenta vs baseline
      const diff = winRate !== null ? +(winRate - baseline).toFixed(1) : null;
      // Sugestie threshold:
      // - daca WR > 80% si n >= 20: poate scadea threshold-ul (mai multe picks valide)
      // - daca WR < 60% si n >= 20: ridica threshold (mai stringent)
      let suggestion = '—';
      if (resolved >= 20) {
        if (winRate >= 80) suggestion = '⬇ scade prag (-5pp): mai multe picks bune';
        else if (winRate < 60) suggestion = '⬆ ridica prag (+10pp): predictii slabe';
        else if (winRate >= 70) suggestion = '✓ baseline ok';
        else suggestion = '⚠ monitor: WR sub baseline';
      }
      return {
        league_id:   r.league_id,
        league:      r.league_name || `Liga ${r.league_id}`,
        country:     r.country || '—',
        total,
        wins,
        losses,
        winRate,
        avgPredicted: Number(avgPred),
        diffFromBaseline: diff,
        suggestion,
      };
    });

    // Categorisez
    const overperformers = insights.filter(i => i.diffFromBaseline !== null && i.diffFromBaseline >= 10);
    const underperformers = insights.filter(i => i.diffFromBaseline !== null && i.diffFromBaseline <= -10);
    const onTarget = insights.filter(i => i.diffFromBaseline !== null && Math.abs(i.diffFromBaseline) < 10);

    res.json({
      ok: true,
      baseline,
      total_leagues: insights.length,
      counts: {
        overperformers: overperformers.length,
        on_target:      onTarget.length,
        underperformers:underperformers.length,
      },
      leagues: insights,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/scanner-state ─────────────────────────────────────────────
router.get('/scanner-state', (req, res) => {
  res.json({ ok: true, paused: getScannerPaused() });
});

// ── POST /api/admin/scanner-toggle ───────────────────────────────────────────
router.post('/scanner-toggle', (req, res) => {
  const newState = !getScannerPaused();
  setScannerPaused(newState);
  res.json({ ok: true, paused: newState });
});

// ── GET /api/admin/api-trend ─────────────────────────────────────────────────
// Trend ultimele 7/30 zile pe consum API. Sursa: cron_logs cu job_name like '%api%'
// sau setting backfill_api_used. Aproximam din numar fixtures procesate per zi.
router.get('/api-trend', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query?.days || '7', 10), 1), 60);

    // Fetch din cron_logs grupat pe zi (fixtures_processed e proxy bun pentru API calls)
    const { rows } = await query(`
      SELECT
        DATE(ran_at) AS day,
        SUM(COALESCE(fixtures_processed, 0))::int AS calls,
        COUNT(*)::int AS runs,
        COUNT(*) FILTER (WHERE status = 'error' OR error_msg IS NOT NULL)::int AS errors
      FROM cron_logs
      WHERE ran_at > NOW() - INTERVAL '${days} days'
      GROUP BY DATE(ran_at)
      ORDER BY day DESC
    `).catch(() => ({ rows: [] }));

    res.json({
      ok: true,
      days,
      total_calls: rows.reduce((s, r) => s + Number(r.calls), 0),
      total_runs: rows.reduce((s, r) => s + Number(r.runs), 0),
      total_errors: rows.reduce((s, r) => s + Number(r.errors), 0),
      data: rows.map(r => ({
        day: r.day,
        calls: Number(r.calls),
        runs: Number(r.runs),
        errors: Number(r.errors),
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/admin/db-cleanup ───────────────────────────────────────────────
// Stergere date vechi din tabele non-critice. Body: {table, days}
// Tabele permise: predictions, cron_logs, alerts, live_stats, prematch_enrichment_log
router.post('/db-cleanup', async (req, res) => {
  try {
    const { table, days } = req.body || {};
    const ALLOWED = {
      'predictions':              { col: 'created_at', label: 'Predictii' },
      'cron_logs':                { col: 'ran_at',     label: 'Logs cron' },
      'alerts':                   { col: 'sent_at',    label: 'Alerte' },
      'live_stats':               { col: 'recorded_at',label: 'Stats live' },
      'prematch_enrichment_log':  { col: 'executed_at',label: 'Log prematch' },
    };
    if (!ALLOWED[table]) {
      return res.status(400).json({ ok: false, error: `Tabel invalid. Permise: ${Object.keys(ALLOWED).join(', ')}` });
    }
    const d = parseInt(days, 10);
    if (!d || d < 7) {
      return res.status(400).json({ ok: false, error: 'days trebuie >= 7 (siguranta)' });
    }
    const { col } = ALLOWED[table];
    // Verifica daca coloana exista
    const checkCol = await query(`
      SELECT EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2
      ) AS exists
    `, [table, col]);
    if (!checkCol.rows[0]?.exists) {
      return res.status(400).json({ ok: false, error: `Coloana ${col} lipseste in ${table}` });
    }
    const result = await query(`DELETE FROM ${table} WHERE ${col} < NOW() - INTERVAL '${d} days'`);
    res.json({
      ok: true,
      table,
      label: ALLOWED[table].label,
      deleted: result.rowCount || 0,
      olderThanDays: d,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/vs-api ────────────────────────────────────────────────────
// Comparatie reala: sistemul nostru vs predictiile API-Football
router.get('/vs-api', async (req, res) => {
  const days = Math.min(parseInt(req.query?.days || '90', 10), 365);
  const safe = q => query(q).catch(() => ({ rows: [] }));
  try {
    const [vsStats, recentRows, selfCorrections] = await Promise.all([
      // Statistici globale
      query(`
        SELECT
          COUNT(*) FILTER (WHERE result_over15 IS NOT NULL AND over15_prob IS NOT NULL)::int AS our_total,
          COUNT(*) FILTER (WHERE result_over15 IS NOT NULL AND over15_prob IS NOT NULL
            AND ((over15_prob >= 50 AND result_over15 = TRUE) OR (over15_prob < 50 AND result_over15 = FALSE)))::int AS our_wins,
          COUNT(*) FILTER (WHERE result_winner IS NOT NULL AND api_home_pct IS NOT NULL)::int AS api_total,
          COUNT(*) FILTER (WHERE result_winner IS NOT NULL AND api_home_pct IS NOT NULL
            AND (
              (api_home_pct >= api_draw_pct AND api_home_pct >= api_away_pct AND result_winner = 'home') OR
              (api_draw_pct > api_home_pct AND api_draw_pct >= api_away_pct AND result_winner = 'draw') OR
              (api_away_pct > api_home_pct AND api_away_pct > api_draw_pct AND result_winner = 'away')
            ))::int AS api_wins,
          COUNT(*) FILTER (WHERE result_over15 IS NOT NULL AND result_winner IS NOT NULL
            AND over15_prob IS NOT NULL AND api_home_pct IS NOT NULL)::int AS hth_total,
          COUNT(*) FILTER (WHERE result_over15 IS NOT NULL AND result_winner IS NOT NULL
            AND over15_prob IS NOT NULL AND api_home_pct IS NOT NULL
            AND ((over15_prob >= 50 AND result_over15 = TRUE) OR (over15_prob < 50 AND result_over15 = FALSE))
            AND NOT (
              (api_home_pct >= api_draw_pct AND api_home_pct >= api_away_pct AND result_winner = 'home') OR
              (api_draw_pct > api_home_pct AND api_draw_pct >= api_away_pct AND result_winner = 'draw') OR
              (api_away_pct > api_home_pct AND api_away_pct > api_draw_pct AND result_winner = 'away')
            ))::int AS we_won_api_lost,
          COUNT(*) FILTER (WHERE result_over15 IS NOT NULL AND result_winner IS NOT NULL
            AND over15_prob IS NOT NULL AND api_home_pct IS NOT NULL
            AND NOT ((over15_prob >= 50 AND result_over15 = TRUE) OR (over15_prob < 50 AND result_over15 = FALSE))
            AND (
              (api_home_pct >= api_draw_pct AND api_home_pct >= api_away_pct AND result_winner = 'home') OR
              (api_draw_pct > api_home_pct AND api_draw_pct >= api_away_pct AND result_winner = 'draw') OR
              (api_away_pct > api_home_pct AND api_away_pct > api_draw_pct AND result_winner = 'away')
            ))::int AS api_won_we_lost,
          COUNT(*) FILTER (WHERE result_over15 IS NOT NULL AND result_winner IS NOT NULL
            AND over15_prob IS NOT NULL AND api_home_pct IS NOT NULL
            AND ((over15_prob >= 50 AND result_over15 = TRUE) OR (over15_prob < 50 AND result_over15 = FALSE))
            AND (
              (api_home_pct >= api_draw_pct AND api_home_pct >= api_away_pct AND result_winner = 'home') OR
              (api_draw_pct > api_home_pct AND api_draw_pct >= api_away_pct AND result_winner = 'draw') OR
              (api_away_pct > api_home_pct AND api_away_pct > api_draw_pct AND result_winner = 'away')
            ))::int AS both_right
        FROM predictions
        WHERE created_at > NOW() - INTERVAL '${days} days'
      `),

      // Ultimele 20 predictii rezolvate cu date de la ambii
      safe(`
        SELECT home_team, away_team, league_name, match_date,
               over15_prob, confidence,
               api_home_pct, api_draw_pct, api_away_pct,
               result_over15, result_winner
        FROM predictions
        WHERE result_over15 IS NOT NULL
          AND api_home_pct IS NOT NULL
          AND result_winner IS NOT NULL
          AND created_at > NOW() - INTERVAL '${days} days'
        ORDER BY match_date DESC
        LIMIT 20
      `),

      // Auto-corectii: league lambda multipliers
      safe(`
        SELECT module, context_key, weight_value, default_value,
               sample_size, win_rate, confidence_level, last_updated
        FROM model_weights
        WHERE weight_name = 'lambda_multiplier'
          AND ABS(weight_value - 1.0) >= 0.05
        ORDER BY ABS(weight_value - 1.0) DESC
        LIMIT 15
      `),
    ]);

    const s = vsStats.rows[0] || {};
    const ourTotal       = Number(s.our_total        || 0);
    const ourWins        = Number(s.our_wins         || 0);
    const apiTotal       = Number(s.api_total        || 0);
    const apiWins        = Number(s.api_wins         || 0);
    const hthTotal       = Number(s.hth_total        || 0);
    const weWonApiLost   = Number(s.we_won_api_lost  || 0);
    const apiWonWeLost   = Number(s.api_won_we_lost  || 0);
    const bothRight      = Number(s.both_right       || 0);
    const bothWrong      = Math.max(0, hthTotal - weWonApiLost - apiWonWeLost - bothRight);

    const recentPreds = recentRows.rows.map(r => {
      const op = Number(r.over15_prob) >= 50 ? 'over15' : 'under15';
      const ourOk = (op === 'over15' && r.result_over15 === true) || (op === 'under15' && r.result_over15 === false);
      const hp = Number(r.api_home_pct || 0);
      const dp = Number(r.api_draw_pct || 0);
      const ap = Number(r.api_away_pct || 0);
      let apiPick = 'home';
      if (dp > hp && dp >= ap)  apiPick = 'draw';
      else if (ap > hp && ap > dp) apiPick = 'away';
      const apiOk = apiPick === r.result_winner;
      return {
        home: r.home_team, away: r.away_team, league: r.league_name,
        date: r.match_date,
        over15_prob: Number(r.over15_prob),
        our_pick: op, our_ok: ourOk,
        api_pick: apiPick,
        api_pct: Math.round(Math.max(hp, dp, ap)),
        api_ok: apiOk,
        result_over15: r.result_over15,
        result_winner: r.result_winner,
      };
    });

    res.json({
      ok: true, days,
      our: {
        total:    ourTotal,
        wins:     ourWins,
        accuracy: ourTotal > 0 ? +(ourWins / ourTotal * 100).toFixed(1) : null,
        note: 'Over/Under 1.5 goals',
      },
      api: {
        total:    apiTotal,
        wins:     apiWins,
        accuracy: apiTotal > 0 ? +(apiWins / apiTotal * 100).toFixed(1) : null,
        note: '1X2 winner prediction',
      },
      hth: {
        total: hthTotal,
        we_won_api_lost:  weWonApiLost,
        api_won_we_lost:  apiWonWeLost,
        both_right:       bothRight,
        both_wrong:       bothWrong,
      },
      self_corrections: selfCorrections.rows.map(r => ({
        context:    r.context_key,
        league_id:  r.context_key?.replace('league_', ''),
        module:     r.module,
        multiplier: Number(r.weight_value),
        direction:  Number(r.weight_value) > 1.0 ? 'UP' : 'DOWN',
        pct_change: Math.round(Math.abs(Number(r.weight_value) - 1.0) * 100),
        samples:    Number(r.sample_size),
        win_rate:   r.win_rate ? Number(r.win_rate) : null,
        confidence: r.confidence_level,
        updated:    r.last_updated,
      })),
      recent: recentPreds,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/db-cleanup-preview ─────────────────────────────────────────
// Preview: cate randuri ar fi sterse fara sa execute
router.get('/db-cleanup-preview', async (req, res) => {
  try {
    const ALLOWED = {
      'predictions': 'created_at',
      'cron_logs': 'ran_at',
      'alerts': 'sent_at',
      'live_stats': 'recorded_at',
      'prematch_enrichment_log': 'executed_at',
    };
    const preview = {};
    for (const [table, col] of Object.entries(ALLOWED)) {
      try {
        const { rows: chk } = await query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2) AS e`, [table, col]);
        if (!chk[0]?.e) { preview[table] = { error: 'col missing' }; continue; }
        const { rows: total } = await query(`SELECT COUNT(*)::int AS n FROM ${table}`);
        const { rows: old30 } = await query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${col} < NOW() - INTERVAL '30 days'`);
        const { rows: old90 } = await query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${col} < NOW() - INTERVAL '90 days'`);
        const { rows: old180 } = await query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${col} < NOW() - INTERVAL '180 days'`);
        preview[table] = {
          total: Number(total[0].n),
          older_30d: Number(old30[0].n),
          older_90d: Number(old90[0].n),
          older_180d: Number(old180[0].n),
        };
      } catch (e) {
        preview[table] = { error: e.message };
      }
    }
    res.json({ ok: true, preview });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
