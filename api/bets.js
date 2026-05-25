// Endpoint pentru tracking pariuri puse de user (bilet manager + ROI).
//
// GET  /api/bets               — lista toate pariurile (cu pagination optional)
// POST /api/bets               — adauga pariu nou
// PUT  /api/bets/:id           — actualizeaza outcome (WIN/LOSS/VOID/PENDING)
// DEL  /api/bets/:id           — sterge
// GET  /api/bets?stats=1       — agregare ROI / win rate
//
// Schema tabel:
//   id, fixture_id, home_team, away_team, league_name, league_id, market,
//   selection, cota, stake, expected_prob, outcome (PENDING/WIN/LOSS/VOID),
//   payout, profit, notes, placed_at, resolved_at

import { query } from './db.js';

async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS bets (
      id            SERIAL PRIMARY KEY,
      fixture_id    INT,
      home_team     TEXT,
      away_team     TEXT,
      league_name   TEXT,
      league_id     INT,
      market        TEXT NOT NULL,
      selection     TEXT,
      cota          NUMERIC(8,3) NOT NULL,
      stake         NUMERIC(10,2) NOT NULL,
      expected_prob NUMERIC(5,2),
      outcome       TEXT DEFAULT 'PENDING',
      payout        NUMERIC(10,2),
      profit        NUMERIC(10,2),
      notes         TEXT,
      placed_at     TIMESTAMP DEFAULT NOW(),
      resolved_at   TIMESTAMP
    )
  `);
  // Migratii lazy pentru tabele existente din versiuni anterioare (fara aceste coloane)
  await query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS fixture_id INT`).catch(() => {});
  await query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS home_team TEXT`).catch(() => {});
  await query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS away_team TEXT`).catch(() => {});
  await query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS outcome TEXT DEFAULT 'PENDING'`).catch(() => {});
  await query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS payout NUMERIC(10,2)`).catch(() => {});
  await query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS profit NUMERIC(10,2)`).catch(() => {});
  await query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS expected_prob NUMERIC(5,2)`).catch(() => {});
  await query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS notes TEXT`).catch(() => {});
  await query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS placed_at TIMESTAMP DEFAULT NOW()`).catch(() => {});
  await query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP`).catch(() => {});
  await query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS league_name TEXT`).catch(() => {});
  await query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS league_id INT`).catch(() => {});
  await query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS selection TEXT`).catch(() => {});
  await query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS is_multi BOOLEAN DEFAULT FALSE`).catch(() => {});
  await query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS legs JSONB`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_bets_outcome ON bets(outcome)`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_bets_placed ON bets(placed_at DESC)`).catch(() => {});
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await ensureTable();
    const method = req.method;

    // GET /api/bets?stats=1
    if (method === 'GET' && req.query?.stats === '1') {
      const days = Math.min(parseInt(req.query.days || '30', 10), 365);
      const { rows: rs } = await query(`
        SELECT
          COUNT(*)::int                                                      AS total,
          COUNT(*) FILTER (WHERE outcome = 'WIN')::int                        AS wins,
          COUNT(*) FILTER (WHERE outcome = 'LOSS')::int                       AS losses,
          COUNT(*) FILTER (WHERE outcome = 'VOID')::int                       AS voids,
          COUNT(*) FILTER (WHERE outcome = 'PENDING')::int                    AS pending,
          COALESCE(SUM(stake) FILTER (WHERE outcome IN ('WIN','LOSS')), 0)    AS staked,
          COALESCE(SUM(profit) FILTER (WHERE outcome IN ('WIN','LOSS')), 0)   AS net_profit,
          COALESCE(AVG(cota)  FILTER (WHERE outcome = 'WIN'),  0)             AS avg_win_cota,
          COALESCE(AVG(expected_prob) FILTER (WHERE outcome IN ('WIN','LOSS')), 0) AS avg_expected_prob
        FROM bets
        WHERE placed_at > NOW() - (INTERVAL '1 day' * $1)
      `, [days]);
      const r = rs[0] || {};
      const resolved = Number(r.wins) + Number(r.losses);
      const staked = Number(r.staked || 0);
      const net = Number(r.net_profit || 0);
      return res.status(200).json({
        ok: true,
        days,
        stats: {
          total:           Number(r.total || 0),
          wins:            Number(r.wins || 0),
          losses:          Number(r.losses || 0),
          voids:           Number(r.voids || 0),
          pending:         Number(r.pending || 0),
          resolved,
          winRate:         resolved > 0 ? +(Number(r.wins) / resolved * 100).toFixed(1) : null,
          staked:          +staked.toFixed(2),
          netProfit:       +net.toFixed(2),
          roi:             staked > 0 ? +(net / staked * 100).toFixed(1) : null,
          avgWinCota:      +Number(r.avg_win_cota || 0).toFixed(2),
          avgExpectedProb: +Number(r.avg_expected_prob || 0).toFixed(1),
        },
      });
    }

    // GET /api/bets — list
    if (method === 'GET') {
      const limit = Math.min(parseInt(req.query?.limit || '50', 10), 500);
      const status = (req.query?.status || '').toUpperCase();
      const wh = status && ['WIN','LOSS','PENDING','VOID'].includes(status) ? `WHERE outcome = '${status}'` : '';
      const { rows } = await query(`
        SELECT id, fixture_id, home_team, away_team, league_name, league_id,
               market, selection, cota, stake, expected_prob, outcome,
               payout, profit, notes, placed_at, resolved_at, is_multi, legs
        FROM bets
        ${wh}
        ORDER BY placed_at DESC
        LIMIT ${limit}
      `);
      return res.status(200).json({ ok: true, bets: rows });
    }

    // POST /api/bets
    if (method === 'POST') {
      const b = req.body || {};
      if (!b.market || !b.cota || !b.stake) {
        return res.status(400).json({ ok: false, error: 'market, cota, stake required' });
      }
      const cota = parseFloat(b.cota);
      const stake = parseFloat(b.stake);
      const expProb = b.expected_prob ? parseFloat(b.expected_prob) : null;
      if (cota <= 1 || stake <= 0) {
        return res.status(400).json({ ok: false, error: 'cota > 1, stake > 0' });
      }
      const isMulti = !!b.is_multi;
      const legs = b.legs ? JSON.stringify(b.legs) : null;
      const { rows } = await query(`
        INSERT INTO bets (fixture_id, home_team, away_team, league_name, league_id,
                          market, selection, cota, stake, expected_prob, outcome, notes,
                          is_multi, legs)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING',$11,$12,$13)
        RETURNING id
      `, [
        b.fixture_id || null, b.home_team || null, b.away_team || null,
        b.league_name || null, b.league_id || null,
        b.market, b.selection || null, cota, stake, expProb, b.notes || null,
        isMulti, legs,
      ]);
      return res.status(200).json({ ok: true, id: rows[0].id });
    }

    // PUT /api/bets/:id — update outcome
    if (method === 'PUT') {
      const id = parseInt(req.query?.id || (req.body || {}).id, 10);
      const outcome = ((req.body || {}).outcome || '').toUpperCase();
      if (!id || !['WIN','LOSS','VOID','PENDING'].includes(outcome)) {
        return res.status(400).json({ ok: false, error: 'id + outcome (WIN/LOSS/VOID/PENDING) required' });
      }
      // Calculam profit din cota * stake
      const { rows: betRows } = await query(`SELECT cota, stake FROM bets WHERE id = $1`, [id]);
      if (!betRows.length) return res.status(404).json({ ok: false, error: 'bet not found' });
      const { cota, stake } = betRows[0];
      let payout = 0, profit = 0;
      if (outcome === 'WIN')  { payout = Number(cota) * Number(stake); profit = payout - Number(stake); }
      else if (outcome === 'LOSS') { payout = 0; profit = -Number(stake); }
      else if (outcome === 'VOID') { payout = Number(stake); profit = 0; }
      await query(`
        UPDATE bets SET outcome = $1, payout = $2, profit = $3,
                        resolved_at = CASE WHEN $1 = 'PENDING' THEN NULL ELSE NOW() END
        WHERE id = $4
      `, [outcome, payout, profit, id]);
      return res.status(200).json({ ok: true, outcome, profit: +profit.toFixed(2) });
    }

    // DELETE /api/bets?id=N
    if (method === 'DELETE') {
      const id = parseInt(req.query?.id, 10);
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      await query(`DELETE FROM bets WHERE id = $1`, [id]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('[bets]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
