// api/utils/fetch-api.js — helper global pentru API-Football cu 429 handling

const BASE = 'https://v3.football.api-sports.io';

function apiKey() {
  return process.env.API_FOOTBALL_KEY
      || process.env.FOOTBALL_API_KEY
      || process.env.APIFOOTBALL_KEY;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Fetch helper cu retry pe 429 (rate-limit).
 * @param {string} url  — URL complet sau cale relativă (ex: /fixtures?live=all)
 * @param {object} options — fetch options (headers suplimentare etc.)
 * @returns {Promise<Response>}
 */
export async function fetchApiFootball(url, options = {}) {
  const fullUrl = url.startsWith('http') ? url : `${BASE}${url}`;
  const headers = {
    'x-apisports-key': apiKey(),
    ...(options.headers || {}),
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(fullUrl, { ...options, headers });

      if (res.status === 429) {
        const wait = attempt === 0 ? 30_000 : 60_000;
        console.warn(`[fetchApiFootball] 429 attempt ${attempt + 1}, waiting ${wait / 1000}s — ${fullUrl}`);
        await sleep(wait);
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status} — ${fullUrl}`);
      return res;
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(5_000);
    }
  }

  throw new Error(`fetchApiFootball: all retries exhausted — ${fullUrl}`);
}
