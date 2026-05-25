// api/admin.js — Admin API Router
// Toate endpoint-urile sunt protejate cu X-Api-Key header

import express      from 'express';
import { query }    from './db.js';
import { getScannerPaused, setScannerPaused } from './cron/scanner.js';

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
  'league-stats':       '/api/cron/league-stats',
  'referee-stats':      '/api/cron/referee-stats',
  'collect-daily':      '/api/cron/collect-daily',
  'collect-finished':   '/api/cron/collect-finished',
  'prematch-enrichment':'/api/cron/prematch-enrichment',
  'scan':               '/api/cron/scan',
  'backfill':           '/api/backfill/start',
  'recalibrate-tables': '/api/cron/recalibrate-tables',
  'calibrate-live':     '/api/cron/calibrate-live',
  'learning-analysis':  '/api/cron/learning-analysis',
  'collect-venues':     '/api/cron/collect-venues',
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

// ── GET /api/admin/bets-aggregate ───────────────────────────────────────────
// Statistici agregate bilete: per market, per liga, distributie cota
router.get('/bets-aggregate', async (req, res) => {
  try {
    // Verifica daca tabela bets exista
    const { rows: tableCheck } = await query(`
      SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='bets') AS exists
    `);
    if (!tableCheck[0]?.exists) {
      return res.json({ ok: true, empty: true, message: 'Tabela bets nu exista inca. Adauga primul pariu in app.' });
    }

    // Asigura coloanele necesare (migrare lazy)
    await query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS is_multi BOOLEAN DEFAULT FALSE`).catch(() => {});
    await query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS legs JSONB`).catch(() => {});

    // Verifica daca exista cel putin un rand
    const { rows: countRows } = await query(`SELECT COUNT(*)::int AS n FROM bets`);
    if (!countRows[0]?.n) {
      return res.json({ ok: true, empty: true, message: 'Tabela bets goala. Adauga primul pariu in app.' });
    }

    // Sumar global
    const { rows: globalRows } = await query(`
      SELECT
        COUNT(*)::int                                                      AS total,
        COUNT(*) FILTER (WHERE outcome = 'WIN')::int                        AS wins,
        COUNT(*) FILTER (WHERE outcome = 'LOSS')::int                       AS losses,
        COUNT(*) FILTER (WHERE outcome = 'VOID')::int                       AS voids,
        COUNT(*) FILTER (WHERE outcome = 'PENDING')::int                    AS pending,
        COUNT(*) FILTER (WHERE COALESCE(is_multi,FALSE) = TRUE)::int         AS multi_count,
        COALESCE(SUM(stake) FILTER (WHERE outcome IN ('WIN','LOSS')), 0)    AS staked,
        COALESCE(SUM(profit) FILTER (WHERE outcome IN ('WIN','LOSS')), 0)   AS net_profit,
        COALESCE(AVG(cota), 0)                                              AS avg_cota,
        COALESCE(AVG(expected_prob), 0)                                     AS avg_expected_prob
      FROM bets
    `);
    const g = globalRows[0] || {};

    // Per market (doar single, non-multi)
    const { rows: byMarket } = await query(`
      SELECT
        market,
        COUNT(*)::int                                                       AS total,
        COUNT(*) FILTER (WHERE outcome = 'WIN')::int                         AS wins,
        COUNT(*) FILTER (WHERE outcome = 'LOSS')::int                        AS losses,
        COALESCE(SUM(stake) FILTER (WHERE outcome IN ('WIN','LOSS')), 0)     AS staked,
        COALESCE(SUM(profit) FILTER (WHERE outcome IN ('WIN','LOSS')), 0)    AS profit
      FROM bets
      WHERE COALESCE(is_multi,FALSE) = FALSE
      GROUP BY market
      HAVING COUNT(*) >= 1
      ORDER BY COUNT(*) DESC
      LIMIT 20
    `).catch(() => ({ rows: [] }));

    // Per liga
    const { rows: byLeague } = await query(`
      SELECT
        league_name,
        COUNT(*)::int                                                       AS total,
        COUNT(*) FILTER (WHERE outcome = 'WIN')::int                         AS wins,
        COUNT(*) FILTER (WHERE outcome = 'LOSS')::int                        AS losses,
        COALESCE(SUM(profit) FILTER (WHERE outcome IN ('WIN','LOSS')), 0)    AS profit
      FROM bets
      WHERE league_name IS NOT NULL AND COALESCE(is_multi,FALSE) = FALSE
      GROUP BY league_name
      HAVING COUNT(*) >= 1
      ORDER BY COUNT(*) DESC
      LIMIT 15
    `).catch(() => ({ rows: [] }));

    // Distributie cota (buckets)
    const { rows: byCotaBucket } = await query(`
      SELECT
        CASE
          WHEN cota < 1.20 THEN '1.00-1.20'
          WHEN cota < 1.30 THEN '1.20-1.30'
          WHEN cota < 1.50 THEN '1.30-1.50'
          WHEN cota < 2.00 THEN '1.50-2.00'
          WHEN cota < 3.00 THEN '2.00-3.00'
          ELSE '3.00+'
        END AS bucket,
        COUNT(*)::int                                                       AS total,
        COUNT(*) FILTER (WHERE outcome = 'WIN')::int                         AS wins,
        COUNT(*) FILTER (WHERE outcome = 'LOSS')::int                        AS losses,
        COALESCE(SUM(profit) FILTER (WHERE outcome IN ('WIN','LOSS')), 0)    AS profit
      FROM bets
      WHERE COALESCE(is_multi,FALSE) = FALSE
      GROUP BY bucket
      ORDER BY MIN(cota)
    `).catch(() => ({ rows: [] }));

    res.json({
      ok: true,
      global: {
        total:      Number(g.total || 0),
        wins:       Number(g.wins || 0),
        losses:     Number(g.losses || 0),
        voids:      Number(g.voids || 0),
        pending:    Number(g.pending || 0),
        multi:      Number(g.multi_count || 0),
        staked:     Number(g.staked || 0),
        netProfit:  Number(g.net_profit || 0),
        avgCota:    Number(g.avg_cota || 0),
        avgExpProb: Number(g.avg_expected_prob || 0),
      },
      by_market: byMarket.map(r => ({
        market:   r.market,
        total:    Number(r.total),
        wins:     Number(r.wins),
        losses:   Number(r.losses),
        staked:   Number(r.staked),
        profit:   Number(r.profit),
        winRate:  (Number(r.wins) + Number(r.losses)) > 0 ? +(Number(r.wins) / (Number(r.wins) + Number(r.losses)) * 100).toFixed(1) : null,
        roi:      Number(r.staked) > 0 ? +(Number(r.profit) / Number(r.staked) * 100).toFixed(1) : null,
      })),
      by_league: byLeague.map(r => ({
        league:   r.league_name,
        total:    Number(r.total),
        wins:     Number(r.wins),
        losses:   Number(r.losses),
        profit:   Number(r.profit),
        winRate:  (Number(r.wins) + Number(r.losses)) > 0 ? +(Number(r.wins) / (Number(r.wins) + Number(r.losses)) * 100).toFixed(1) : null,
      })),
      by_cota: byCotaBucket.map(r => ({
        bucket:   r.bucket,
        total:    Number(r.total),
        wins:     Number(r.wins),
        losses:   Number(r.losses),
        profit:   Number(r.profit),
        winRate:  (Number(r.wins) + Number(r.losses)) > 0 ? +(Number(r.wins) / (Number(r.wins) + Number(r.losses)) * 100).toFixed(1) : null,
      })),
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
