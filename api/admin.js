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
  'scan':               '/api/cron/scan',
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
// Distributia win rate-ului real (din prediction_log) pe mai multe dimensiuni:
// bucket NGP, minut, scor curent, liga. Util pentru:
// - validarea calibration table (NGP_CAL_REST)
// - identificarea contextelor cu performanta superioara
// - tuning manual al threshold-urilor
//
// Query params:
//   days=30 (default), maxim 365
//   module=NGP|OVER15 (default NGP)
//   minSamples=5 (default), elimina bucket-uri sub acest prag
//   league_id=NNN (optional) restrange la o singura liga
router.get('/win-rate-patterns', async (req, res) => {
  const days       = Math.min(parseInt(req.query?.days       || '30',  10), 365);
  const minSamples = Math.max(parseInt(req.query?.minSamples || '5',   10), 1);
  const moduleQ    = (req.query?.module || 'NGP').toUpperCase();
  const leagueId   = req.query?.league_id ? parseInt(req.query.league_id, 10) : null;

  if (!['NGP', 'OVER15'].includes(moduleQ)) {
    return res.status(400).json({ ok: false, error: 'module must be NGP or OVER15' });
  }

  try {
    const baseWhere = `
      module = $1
      AND created_at > NOW() - INTERVAL '${days} days'
      AND outcome IN ('WIN','LOSS')
      ${leagueId ? 'AND league_id = $2' : ''}
    `;
    const baseWhereAll = `
      module = $1
      AND created_at > NOW() - INTERVAL '${days} days'
      ${leagueId ? 'AND league_id = $2' : ''}
    `;
    const params = leagueId ? [moduleQ, leagueId] : [moduleQ];

    // 1. Overall counters
    const { rows: ovRows } = await query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE outcome = 'WIN')     AS wins,
        COUNT(*) FILTER (WHERE outcome = 'LOSS')    AS losses,
        COUNT(*) FILTER (WHERE outcome = 'PENDING') AS pending
      FROM prediction_log
      WHERE ${baseWhereAll}
    `, params);
    const ov = ovRows[0] || {};
    const ovResolved = Number(ov.wins || 0) + Number(ov.losses || 0);
    const overall = {
      total:    Number(ov.total || 0),
      wins:     Number(ov.wins || 0),
      losses:   Number(ov.losses || 0),
      pending:  Number(ov.pending || 0),
      resolved: ovResolved,
      winRate:  ovResolved > 0 ? +(Number(ov.wins) / ovResolved * 100).toFixed(1) : null,
    };

    // 2. Per bucket NGP
    const { rows: ngpRows } = await query(`
      SELECT
        CASE
          WHEN COALESCE(ngp_value, predicted_value) < 60 THEN '50-60'
          WHEN COALESCE(ngp_value, predicted_value) < 70 THEN '60-70'
          WHEN COALESCE(ngp_value, predicted_value) < 80 THEN '70-80'
          WHEN COALESCE(ngp_value, predicted_value) < 90 THEN '80-90'
          ELSE '90-100'
        END AS bucket,
        COUNT(*) AS n,
        COUNT(*) FILTER (WHERE outcome = 'WIN') AS wins
      FROM prediction_log
      WHERE ${baseWhere}
      GROUP BY bucket
      ORDER BY bucket
    `, params);
    const byNgpBucket = ngpRows
      .filter(r => Number(r.n) >= minSamples)
      .map(r => ({
        range:   r.bucket,
        n:       Number(r.n),
        wins:    Number(r.wins),
        winRate: +(Number(r.wins) / Number(r.n) * 100).toFixed(1),
      }));

    // 3. Per minute range
    const { rows: minRows } = await query(`
      SELECT
        CASE
          WHEN minute <= 15 THEN '5-15'
          WHEN minute <= 30 THEN '16-30'
          WHEN minute <= 45 THEN '31-45'
          WHEN minute <= 60 THEN '46-60'
          WHEN minute <= 75 THEN '61-75'
          ELSE '76-85'
        END AS bucket,
        MIN(minute) AS sort_key,
        COUNT(*) AS n,
        COUNT(*) FILTER (WHERE outcome = 'WIN') AS wins
      FROM prediction_log
      WHERE ${baseWhere} AND minute IS NOT NULL
      GROUP BY bucket
      ORDER BY sort_key
    `, params);
    const byMinuteRange = minRows
      .filter(r => Number(r.n) >= minSamples)
      .map(r => ({
        range:   r.bucket,
        n:       Number(r.n),
        wins:    Number(r.wins),
        winRate: +(Number(r.wins) / Number(r.n) * 100).toFixed(1),
      }));

    // 4. Per score state (top 12 cele mai frecvente)
    const { rows: scoreRows } = await query(`
      SELECT
        score_at_prediction AS state,
        COUNT(*) AS n,
        COUNT(*) FILTER (WHERE outcome = 'WIN') AS wins
      FROM prediction_log
      WHERE ${baseWhere} AND score_at_prediction IS NOT NULL
      GROUP BY score_at_prediction
      HAVING COUNT(*) >= ${minSamples}
      ORDER BY COUNT(*) DESC
      LIMIT 12
    `, params);
    const byScoreState = scoreRows.map(r => ({
      state:   r.state,
      n:       Number(r.n),
      wins:    Number(r.wins),
      winRate: +(Number(r.wins) / Number(r.n) * 100).toFixed(1),
    }));

    // 5. Per league (top 25, doar daca nu e filtru pe league_id)
    let byLeague = null;
    if (!leagueId) {
      const { rows: lgRows } = await query(`
        SELECT
          league_name AS league,
          league_id,
          COUNT(*) AS n,
          COUNT(*) FILTER (WHERE outcome = 'WIN') AS wins
        FROM prediction_log
        WHERE ${baseWhere} AND league_name IS NOT NULL
        GROUP BY league_name, league_id
        HAVING COUNT(*) >= ${minSamples}
        ORDER BY COUNT(*) FILTER (WHERE outcome = 'WIN')::float / NULLIF(COUNT(*), 0) DESC
        LIMIT 25
      `, params);
      byLeague = lgRows.map(r => ({
        league:    r.league,
        league_id: r.league_id,
        n:         Number(r.n),
        wins:      Number(r.wins),
        winRate:   +(Number(r.wins) / Number(r.n) * 100).toFixed(1),
      }));
    }

    res.json({
      ok: true,
      meta: { days, module: moduleQ, minSamples, leagueId, asOf: new Date().toISOString() },
      overall,
      byNgpBucket,
      byMinuteRange,
      byScoreState,
      ...(byLeague ? { byLeague } : {}),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
