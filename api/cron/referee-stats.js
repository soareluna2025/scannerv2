// api/cron/referee-stats.js
// Calculează statistici per arbitru din fixtures_history + match_stats
// Rulează zilnic la 04:00 — populează referee în fixtures_history din API, calcul SQL local

import { query } from '../db.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function cleanRefName(raw) {
  if (!raw || raw === 'null') return null;
  return raw.split(',')[0].trim() || null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.FOOTBALL_API_KEY || process.env.APIFOOTBALL_KEY || process.env.API_FOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'API_FOOTBALL_KEY neconfigurat' });

  const hdr   = { 'x-apisports-key': key };
  const start = Date.now();

  try {
    // Step 1: Crează tabel referee_stats
    await query(`
      CREATE TABLE IF NOT EXISTS referee_stats (
        referee_name      VARCHAR(200) PRIMARY KEY,
        total_matches     INTEGER DEFAULT 0,
        avg_yellow_cards  DECIMAL(4,2) DEFAULT 0,
        avg_red_cards     DECIMAL(4,2) DEFAULT 0,
        avg_penalties     DECIMAL(4,2) DEFAULT 0,
        avg_fouls         DECIMAL(4,2) DEFAULT 0,
        avg_corners       DECIMAL(4,2) DEFAULT 0,
        avg_goals         DECIMAL(4,2) DEFAULT 0,
        pct_over_25       DECIMAL(5,2) DEFAULT 0,
        pct_gg            DECIMAL(5,2) DEFAULT 0,
        pct_btts          DECIMAL(5,2) DEFAULT 0,
        referee_style     VARCHAR(20) DEFAULT 'neutral',
        updated_at        TIMESTAMP DEFAULT NOW()
      )
    `);

    // Adaugă coloana referee la fixtures_history dacă nu există (idempotent)
    await query(`ALTER TABLE fixtures_history ADD COLUMN IF NOT EXISTS referee TEXT`);

    // Step 2: Fetch ultimele 30 zile + 3 zile viitoare din API → colectează referee per fixture_id
    const today = new Date();
    const dates = [];
    for (let d = -30; d <= 3; d++) {
      const dt = new Date(today);
      dt.setDate(dt.getDate() + d);
      dates.push(dt.toISOString().slice(0, 10));
    }

    const fixtureData = {}; // fixture_id → {referee, status_short, home_goals, away_goals}
    let apiFetched = 0;
    for (const date of dates) {
      try {
        const r    = await fetch(`https://v3.football.api-sports.io/fixtures?date=${date}`, { headers: hdr });
        const data = await r.json();
        for (const fix of data.response || []) {
          const name = cleanRefName(fix.fixture?.referee);
          if (fix.fixture?.id) {
            fixtureData[fix.fixture.id] = {
              referee:      name,
              status_short: fix.fixture?.status?.short || null,
              home_goals:   fix.goals?.home ?? null,
              away_goals:   fix.goals?.away ?? null,
            };
          }
        }
        apiFetched++;
        await sleep(300);
      } catch (_) { await sleep(300); }
    }

    // Batch UPDATE fixtures_history — referee + status + goals (ține DB la zi)
    const fids       = Object.keys(fixtureData).map(Number);
    const referees   = fids.map(id => fixtureData[id].referee);
    const statuses   = fids.map(id => fixtureData[id].status_short);
    const homeGoals  = fids.map(id => fixtureData[id].home_goals);
    const awayGoals  = fids.map(id => fixtureData[id].away_goals);

    if (fids.length > 0) {
      await query(
        `UPDATE fixtures_history fh
         SET referee      = COALESCE(u.referee, fh.referee),
             status_short = COALESCE(u.status_short, fh.status_short),
             home_goals   = COALESCE(u.home_goals, fh.home_goals),
             away_goals   = COALESCE(u.away_goals, fh.away_goals)
         FROM unnest($1::integer[], $2::text[], $3::text[], $4::integer[], $5::integer[])
           AS u(fid, referee, status_short, home_goals, away_goals)
         WHERE fh.fixture_id = u.fid`,
        [fids, referees, statuses, homeGoals, awayGoals]
      );
    }

    // Step 3: Calculează statistici goluri per arbitru din fixtures_history
    const { rows: goalRows } = await query(`
      SELECT
        referee,
        COUNT(*) AS total_matches,
        AVG(home_goals + away_goals)::NUMERIC(4,2)                                          AS avg_goals,
        (100.0 * COUNT(*) FILTER (WHERE home_goals + away_goals >= 3) / COUNT(*))::NUMERIC(5,2) AS pct_over_25,
        (100.0 * COUNT(*) FILTER (WHERE home_goals > 0 AND away_goals > 0) / COUNT(*))::NUMERIC(5,2) AS pct_gg
      FROM fixtures_history
      WHERE referee IS NOT NULL
        AND status_short = 'FT'
        AND home_goals IS NOT NULL
        AND away_goals IS NOT NULL
      GROUP BY referee
      HAVING COUNT(*) >= 5
    `);

    // Statistici carduri/cornere/fault-uri din match_stats JOIN fixtures_history
    const { rows: cardRows } = await query(`
      SELECT
        fh.referee,
        AVG(pm.yc)::NUMERIC(4,2)      AS avg_yellow,
        AVG(pm.rc)::NUMERIC(4,2)      AS avg_red,
        AVG(pm.corners)::NUMERIC(4,2) AS avg_corners,
        AVG(pm.fouls)::NUMERIC(4,2)   AS avg_fouls
      FROM (
        SELECT fixture_id,
          SUM(COALESCE(yellow_cards,0)) AS yc,
          SUM(COALESCE(red_cards,0))    AS rc,
          SUM(COALESCE(corner_kicks,0)) AS corners,
          SUM(COALESCE(fouls,0))        AS fouls
        FROM match_stats
        GROUP BY fixture_id
      ) pm
      JOIN fixtures_history fh ON fh.fixture_id = pm.fixture_id
      WHERE fh.referee IS NOT NULL
      GROUP BY fh.referee
    `).catch(() => ({ rows: [] }));

    // Penaltyuri din match_events JOIN fixtures_history
    const { rows: penRows } = await query(`
      SELECT
        fh.referee,
        AVG(ev.pen_count)::NUMERIC(4,2) AS avg_penalties
      FROM (
        SELECT fixture_id, COUNT(*) AS pen_count
        FROM match_events
        WHERE type = 'Goal' AND detail = 'Penalty'
        GROUP BY fixture_id
      ) ev
      JOIN fixtures_history fh ON fh.fixture_id = ev.fixture_id
      WHERE fh.referee IS NOT NULL
      GROUP BY fh.referee
    `).catch(() => ({ rows: [] }));

    const cardMap = Object.fromEntries(cardRows.map(r => [r.referee, r]));
    const penMap  = Object.fromEntries(penRows.map(r => [r.referee, parseFloat(r.avg_penalties) || 0]));

    let upserted = 0;
    for (const row of goalRows) {
      const refName  = row.referee;
      const avgGoals = parseFloat(row.avg_goals) || 0;
      const avgYC    = parseFloat(cardMap[refName]?.avg_yellow) || 0;

      let refereeStyle = 'neutral';
      if      (avgYC    >= 5.0) refereeStyle = 'strict';
      else if (avgYC    <= 2.5) refereeStyle = 'lenient';
      else if (avgGoals >= 3.0) refereeStyle = 'open';
      else if (avgGoals <= 1.8) refereeStyle = 'closed';

      await query(`
        INSERT INTO referee_stats
          (referee_name, total_matches,
           avg_yellow_cards, avg_red_cards, avg_penalties,
           avg_fouls, avg_corners, avg_goals,
           pct_over_25, pct_gg, pct_btts,
           referee_style, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
        ON CONFLICT (referee_name) DO UPDATE SET
          total_matches=EXCLUDED.total_matches,
          avg_yellow_cards=EXCLUDED.avg_yellow_cards,
          avg_red_cards=EXCLUDED.avg_red_cards,
          avg_penalties=EXCLUDED.avg_penalties,
          avg_fouls=EXCLUDED.avg_fouls,
          avg_corners=EXCLUDED.avg_corners,
          avg_goals=EXCLUDED.avg_goals,
          pct_over_25=EXCLUDED.pct_over_25,
          pct_gg=EXCLUDED.pct_gg,
          pct_btts=EXCLUDED.pct_btts,
          referee_style=EXCLUDED.referee_style,
          updated_at=NOW()
      `, [
        refName,
        parseInt(row.total_matches),
        avgYC,
        parseFloat(cardMap[refName]?.avg_red)     || 0,
        penMap[refName] || 0,
        parseFloat(cardMap[refName]?.avg_fouls)   || 0,
        parseFloat(cardMap[refName]?.avg_corners) || 0,
        avgGoals,
        parseFloat(row.pct_over_25) || 0,
        parseFloat(row.pct_gg)      || 0,
        parseFloat(row.pct_gg)      || 0,
        refereeStyle,
      ]);
      upserted++;
    }

    return res.status(200).json({
      ok:                  true,
      duration_ms:         Date.now() - start,
      api_dates_fetched:   apiFetched,
      fixtures_updated:    fids.length,
      referees_processed:  upserted,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
