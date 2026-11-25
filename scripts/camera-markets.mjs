// Diagnostic read-only: afiseaza numele pietelor Polymarket pentru un meci (ca sa mapam "gazde/oaspeti marcheaza").
// Rulare: cd /root/scannerv2 && node --env-file=.env scripts/camera-markets.mjs
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });
const r = await pool.query("SELECT l.slug FROM polymarket_links l JOIN fixtures f ON f.fixture_id=l.fixture_id WHERE f.match_date > now() ORDER BY f.match_date LIMIT 2");
for (const { slug } of r.rows) {
  for (const s of [slug, slug + '-more-markets']) {
    const ev = await (await fetch('https://gamma-api.polymarket.com/events?slug=' + s)).json();
    console.log('\n== ' + s + ' (' + (ev[0]?.markets?.length || 0) + ' piete)');
    (ev[0]?.markets || []).forEach(m => console.log(' - ' + (m.question || m.groupItemTitle)));
  }
}
await pool.end();
