// api/cron/referee-stats.js
// Calculează statistici per arbitru din API-Football + match_stats din DB
// Rulează zilnic la 04:00 — max 50 arbitri per rulare, sleep 300ms între apeluri

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
    // Step 1: Crează tabelul
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

    // Step 2: Colectează nume arbitri din meciurile următoare 3 zile + ieri
    const today = new Date();
    const datesToFetch = [-1, 0, 1, 2].map(d => {
      const dt = new Date(today);
      dt.setDate(dt.getDate() + d);
      return dt.toISOString().slice(0, 10);
    });

    const refereeNames = new Set();
    for (const date of datesToFetch) {
      try {
        const r    = await fetch(`https://v3.football.api-sports.io/fixtures?date=${date}`, { headers: hdr });
        const data = await r.json();
        for (const fix of data.response || []) {
          const name = cleanRefName(fix.fixture?.referee);
          if (name) refereeNames.add(name);
        }
        await sleep(300);
      } catch (_) { await sleep(300); }
    }

    // Limitează la 50 arbitri per rulare
    const refList    = [...refereeNames].slice(0, 50);
    const season     = today.getFullYear();
    let   upserted   = 0;

    for (const refName of refList) {
      try {
        // Fetch meciuri terminate pentru arbitru (sezon curent)
        const r1   = await fetch(
          `https://v3.football.api-sports.io/fixtures?referee=${encodeURIComponent(refName)}&season=${season}&status=FT`,
          { headers: hdr }
        );
        const d1   = await r1.json();
        let fixtures = d1.response || [];
        await sleep(300);

        // Dacă < 5 meciuri, încearcă și sezonul anterior
        if (fixtures.length < 5) {
          const r2 = await fetch(
            `https://v3.football.api-sports.io/fixtures?referee=${encodeURIComponent(refName)}&season=${season - 1}&status=FT`,
            { headers: hdr }
          );
          const d2 = await r2.json();
          fixtures  = fixtures.concat(d2.response || []);
          await sleep(300);
        }

        if (fixtures.length < 5) continue; // sub minim, skip

        const fixtureIds = fixtures.map(f => f.fixture?.id).filter(Boolean);

        // Citește card/corner/fouls din match_stats DB
        let statsMap = {};
        if (fixtureIds.length > 0) {
          const { rows } = await query(
            `SELECT fixture_id,
               SUM(COALESCE(yellow_cards,0)) AS yc,
               SUM(COALESCE(red_cards,0))    AS rc,
               SUM(COALESCE(corner_kicks,0)) AS corners,
               SUM(COALESCE(fouls,0))        AS fouls
             FROM match_stats
             WHERE fixture_id = ANY($1)
             GROUP BY fixture_id`,
            [fixtureIds]
          ).catch(() => ({ rows: [] }));
          statsMap = Object.fromEntries(rows.map(r => [Number(r.fixture_id), r]));
        }

        // Citește penaltyuri din match_events DB
        let penaltiesMap = {};
        if (fixtureIds.length > 0) {
          const { rows } = await query(
            `SELECT fixture_id, COUNT(*) AS pen
             FROM match_events
             WHERE fixture_id = ANY($1)
               AND type = 'Goal'
               AND detail = 'Penalty'
             GROUP BY fixture_id`,
            [fixtureIds]
          ).catch(() => ({ rows: [] }));
          penaltiesMap = Object.fromEntries(rows.map(r => [Number(r.fixture_id), Number(r.pen)]));
        }

        // Calculează agregate
        let totalYC = 0, totalRC = 0, totalCorners = 0, totalFouls = 0;
        let totalGoals = 0, totalPenalties = 0;
        let over25Count = 0, ggCount = 0, statsCount = 0;

        for (const fix of fixtures) {
          const fid     = fix.fixture?.id;
          const hGoals  = fix.goals?.home ?? 0;
          const aGoals  = fix.goals?.away ?? 0;
          const total   = hGoals + aGoals;

          totalGoals    += total;
          totalPenalties += penaltiesMap[fid] || 0;
          if (total >= 3)           over25Count++;
          if (hGoals > 0 && aGoals > 0) ggCount++;

          if (statsMap[fid]) {
            const s = statsMap[fid];
            totalYC      += Number(s.yc)      || 0;
            totalRC      += Number(s.rc)      || 0;
            totalCorners += Number(s.corners) || 0;
            totalFouls   += Number(s.fouls)   || 0;
            statsCount++;
          }
        }

        const n       = fixtures.length;
        const r2d     = v => Math.round(v * 100) / 100;
        const avgGoals  = r2d(totalGoals / n);
        const avgYC     = statsCount > 0 ? r2d(totalYC      / statsCount) : 0;
        const avgRC     = statsCount > 0 ? r2d(totalRC      / statsCount) : 0;
        const avgCorners = statsCount > 0 ? r2d(totalCorners / statsCount) : 0;
        const avgFouls   = statsCount > 0 ? r2d(totalFouls   / statsCount) : 0;
        const avgPen    = r2d(totalPenalties / n);
        const pctOver25 = r2d((over25Count / n) * 100);
        const pctGG     = r2d((ggCount / n) * 100);

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
          refName, n,
          avgYC, avgRC, avgPen,
          avgFouls, avgCorners, avgGoals,
          pctOver25, pctGG, pctGG,
          refereeStyle,
        ]);
        upserted++;

      } catch (_) { await sleep(300); }
    }

    return res.status(200).json({
      ok:                  true,
      duration_ms:         Date.now() - start,
      referees_found:      refereeNames.size,
      referees_processed:  upserted,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
