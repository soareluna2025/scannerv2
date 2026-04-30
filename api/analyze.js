function log(msg) {
  console.log(`[analyze] ${new Date().toISOString()} ${msg}`);
}

function getStat(statistics, teamIdx, type) {
  const team = statistics?.[teamIdx]?.statistics;
  if (!Array.isArray(team)) return 0;
  const entry = team.find(s => s.type === type);
  const v = entry?.value;
  if (v === null || v === undefined || v === 'N/A' || v === '') return 0;
  return parseFloat(v) || 0;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const grokKey      = process.env.XAI_API_KEY || process.env.GROQ_KEY;
  if (!anthropicKey && !grokKey) {
    log('ERROR: no AI key configured');
    return res.status(500).json({ error: 'Niciun API key AI configurat' });
  }

  const { matches } = req.body || {};
  if (!Array.isArray(matches) || matches.length === 0) {
    return res.status(400).json({ error: 'No matches provided' });
  }

  const summaries = matches.slice(0, 25).map((m, i) => {
    const home   = m.teams?.home?.name || 'Home';
    const away   = m.teams?.away?.name || 'Away';
    const hg     = m.goals?.home ?? 0;
    const ag     = m.goals?.away ?? 0;
    const mn     = m.fixture?.status?.elapsed || 0;
    const league = m.league?.name || 'Unknown';
    const st     = m.statistics || [];

    // Use pre-extracted xG if available (from football.js), else parse from stats
    const hxg = m.xg?.home ?? getStat(st, 0, 'expected_goals');
    const axg = m.xg?.away ?? getStat(st, 1, 'expected_goals');

    const hSOT    = getStat(st, 0, 'Shots on Goal');
    const aSOT    = getStat(st, 1, 'Shots on Goal');
    const hSoff   = getStat(st, 0, 'Shots off Goal');
    const aSoff   = getStat(st, 1, 'Shots off Goal');
    const corners = getStat(st, 0, 'Corner Kicks') + getStat(st, 1, 'Corner Kicks');
    const poss    = getStat(st, 0, 'Ball Possession') || 50;
    const hDA     = getStat(st, 0, 'Dangerous Attacks');
    const aDA     = getStat(st, 1, 'Dangerous Attacks');

    return `${i}. [${league}] ${home} ${hg}-${ag} ${away} | Min:${mn}' | xG:${hxg.toFixed(2)}+${axg.toFixed(2)} | SuT:${hSOT+aSOT} | SuTotal:${hSOT+hSoff+aSOT+aSoff} | Cornere:${corners} | Poss:${poss}% | Atacuri:${hDA+aDA}`;
  });

  const systemPrompt = `Ești un analist de fotbal expert specializat în predicții live. Pentru fiecare meci primit calculează:
1. "score" (0-100): scor compozit bazat pe probabilitatea unui gol iminent (xG, șuturi, presiune, minute jucate, atacuri periculoase)
2. "recommendation": maxim 2 propoziții în română cu recomandarea ta specifică și concisă

Răspunde STRICT cu JSON array, fără niciun text suplimentar:
[{"id":0,"score":75,"recommendation":"Arsenal atacă intens cu xG 1.8. Recomandat Over 0.5 repriza a doua."},...]`;

  const userContent = 'Analizează meciurile live:\n' + summaries.join('\n');

  async function tryAnthropic() {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, system: systemPrompt, messages: [{ role: 'user', content: userContent }] })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || `Anthropic HTTP ${r.status}`);
    return data.content?.[0]?.text || '[]';
  }

  async function tryGrok() {
    const r = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${grokKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'grok-3-mini', max_tokens: 2000, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }] })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || `Grok HTTP ${r.status}`);
    return data.choices?.[0]?.message?.content || '[]';
  }

  try {
    log(`analyzing ${summaries.length} matches`);
    let text = '[]';

    if (anthropicKey) {
      try {
        text = await tryAnthropic();
        log('Anthropic ok');
      } catch (e) {
        log(`Anthropic failed: ${e.message} — trying Grok`);
        if (!grokKey) throw e;
        text = await tryGrok();
        log('Grok fallback ok');
      }
    } else {
      text = await tryGrok();
      log('Grok ok');
    }

    log(`raw response: ${text.substring(0, 120)}...`);
    const match = text.match(/\[[\s\S]*\]/);
    const analysis = match ? JSON.parse(match[0]) : [];
    log(`parsed ${analysis.length} analysis results`);

    return res.status(200).json({ analysis });
  } catch (e) {
    log(`ERROR: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
}
