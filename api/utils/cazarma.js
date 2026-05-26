import { query } from '../db.js';

export async function writeToCazarma(sursa, endpoint, entityId, rawData) {
  try {
    await query(
      `INSERT INTO cazarma_centrala (sursa, endpoint, entity_id, raw_data)
       VALUES ($1, $2, $3, $4)`,
      [sursa, endpoint, entityId || null, JSON.stringify(rawData)]
    );
  } catch (_) {}
}
