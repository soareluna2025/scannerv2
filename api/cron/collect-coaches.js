// Cron: colectare coaches per echipa
// Pentru fiecare echipa fara antrenor in DB, fetch /coachs?team=X.
// API returneaza: id, name, age, nationality, career array (echipe + start/end).
//
// Trigger: GET /api/cron/collect-coaches
// Cron: 0 5 * * 1 (luni 05:00, saptamanal)
// Cost API: ~7500 echipe = 7500 calls one-time, apoi doar update

import { query } from '../db.js';
import { fetchApiFootball } from '../utils/fetch-api.js';

async function ensureColumns() {
  // Adauga coloane extinse daca lipsesc
  await query(`ALTER TABLE coaches ADD COLUMN IF NOT EXISTS photo TEXT`).catch(() => {});
  await query(`ALTER TABLE coaches ADD COLUMN IF NOT EXISTS birth_date DATE`).catch(() => {});
  await query(`ALTER TABLE coaches ADD COLUMN IF NOT EXISTS birth_place TEXT`).catch(() => {});
  await query(`ALTER TABLE coaches ADD COLUMN IF NOT EXISTS birth_country TEXT`).catch(() => {});
  await query(`ALTER TABLE coaches ADD COLUMN IF NOT EXISTS height TEXT`).catch(() => {});
  await query(`ALTER TABLE coaches ADD COLUMN IF NOT EXISTS weight TEXT`).catch(() => {});

  // Tabel separat pentru istoric cariera (echipe + start/end)
  await query(`
    CREATE TABLE IF NOT EXISTS coach_career (
      id           SERIAL PRIMARY KEY,
      coach_id     INT NOT NULL,
      team_id      INT,
      team_name    TEXT,
      start_date   DATE,
      end_date     DATE,
      UNIQUE (coach_id, team_id, start_date)
    )
  `).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_coach_career_coach ON coach_career(coach_id)`).catch(() => {});
}

async function collectOne(teamId, teamName) {
  try {
    const r = await fetchApiFootball(`/coachs?team=${teamId}`);
    const d = await r.json();
    const items = d.response || [];
    if (!items.length) return null;
    let saved = 0;
    for (const c of items) {
      if (!c.id) continue;
      // INSERT coach principal
      await query(`
        INSERT INTO coaches (coach_id, team_id, team_name, name, firstname, lastname, nationality, age, photo, birth_date, birth_place, birth_country, height, weight, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
        ON CONFLICT (coach_id, team_id) DO UPDATE SET
          name = EXCLUDED.name,
          firstname = EXCLUDED.firstname,
          lastname = EXCLUDED.lastname,
          nationality = EXCLUDED.nationality,
          age = EXCLUDED.age,
          photo = EXCLUDED.photo,
          birth_date = EXCLUDED.birth_date,
          birth_place = EXCLUDED.birth_place,
          birth_country = EXCLUDED.birth_country,
          height = EXCLUDED.height,
          weight = EXCLUDED.weight,
          updated_at = NOW()
      `, [
        c.id, teamId, teamName, c.name || null, c.firstname || null, c.lastname || null,
        c.nationality || null, c.age || null, c.photo || null,
        c.birth?.date || null, c.birth?.place || null, c.birth?.country || null,
        c.height || null, c.weight || null,
      ]).catch(e => console.warn(`[coaches] insert ${c.id}:`, e.message));
      saved++;
      // Career history (array of {team, start, end})
      const career = c.career || [];
      for (const ent of career) {
        await query(`
          INSERT INTO coach_career (coach_id, team_id, team_name, start_date, end_date)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (coach_id, team_id, start_date) DO UPDATE SET
            end_date = EXCLUDED.end_date
        `, [
          c.id, ent.team?.id || null, ent.team?.name || null,
          ent.start || null, ent.end || null,
        ]).catch(() => {});
      }
    }
    return { team_id: teamId, team_name: teamName, coaches_found: saved };
  } catch (e) {
    console.warn(`[coaches] team ${teamId}:`, e.message);
    return null;
  }
}

export default async function handler(req, res) {
  try {
    await ensureColumns();
    const LIMIT = parseInt(req.query?.limit || '200', 10);

    // Echipe fara antrenor in DB
    const { rows: teams } = await query(`
      SELECT team_id, name FROM teams
      WHERE team_id NOT IN (SELECT DISTINCT team_id FROM coaches WHERE team_id IS NOT NULL)
      ORDER BY team_id
      LIMIT $1
    `, [LIMIT]).catch(() => ({ rows: [] }));

    const collected = [];
    for (const t of teams) {
      const out = await collectOne(t.team_id, t.name);
      if (out) collected.push(out);
      await new Promise(r => setTimeout(r, 100));
    }

    await query(`
      INSERT INTO cron_logs (job_name, ran_at, status, fixtures_processed)
      VALUES ('collect-coaches', NOW(), 'success', $1)
    `, [collected.length]).catch(() => {});

    const { rows: totalRows } = await query(`
      SELECT COUNT(DISTINCT coach_id)::int AS coaches, COUNT(*)::int AS rows
      FROM coaches
    `).catch(() => ({ rows: [{ coaches: 0, rows: 0 }] }));

    return res.status(200).json({
      ok: true,
      teams_processed: teams.length,
      collected: collected.length,
      total_unique_coaches: totalRows[0]?.coaches || 0,
      total_coach_rows: totalRows[0]?.rows || 0,
      sample: collected.slice(0, 5),
    });
  } catch (e) {
    console.error('[collect-coaches]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
