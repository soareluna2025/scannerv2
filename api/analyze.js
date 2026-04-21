import Anthropic from '@anthropic-ai/sdk';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { matches } = req.body || {};
  if (!Array.isArray(matches) || matches.length === 0) {
    return res.status(400).json({ error: 'No matches provided' });
  }

  const client = new Anthropic({ apiKey: key });

  const summaries = matches.slice(0, 25).map((m, i) => {
    const home = m.teams?.home?.name || 'Home';
    const away = m.teams?.away?.name || 'Away';
    const hg = m.goals?.home ?? 0;
    const ag = m.goals?.away ?? 0;
    const mn = m.fixture?.status?.elapsed || 0;
    const league = m.league?.name || 'Unknown';
    const st = m.statistics || [];
    const getS = (ti, nm) => {
      if (!st[ti]?.statistics) return 0;
      const f = st[ti].statistics.find(x => x.type === nm);
      return parseFloat(f?.value) || 0;
    };
    const hxg = getS(0, 'expected_goals');
    const axg = getS(1, 'expected_goals');
    const shots = getS(0, 'Shots on Goal') + getS(0, 'Shots off Goal') + getS(1, 'Shots on Goal') + getS(1, 'Shots off Goal');
    const corners = getS(0, 'Corner Kicks') + getS(1, 'Corner Kicks');
    const poss = getS(0, 'Ball Possession') || 50;
    return `${i}. ${league}: ${home} ${hg}-${ag} ${away} | Min:${mn} | xG:${hxg.toFixed(1)}+${axg.toFixed(1)} | Sut:${shots} | Cornere:${corners} | Poss:${poss}%`;
  });

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: [
        {
          type: 'text',
          text: `Ești un analist de fotbal expert specializat în predicții live. Pentru fiecare meci primit calculează:
1. "score" (0-100): scor compozit bazat pe probabilitatea unui gol iminent (xG, șuturi, presiune, minute jucate)
2. "recommendation": maxim 2 propoziții în română cu recomandarea ta specifică și concisă

Răspunde DOAR cu JSON array, fără text suplimentar:
[{"id":0,"score":75,"recommendation":"Ambele echipe atacă intens cu xG ridicat. Recomandat Over 0.5 repriza a doua."},...]`,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [
        {
          role: 'user',
          content: 'Analizează meciurile live:\n' + summaries.join('\n')
        }
      ]
    });

    const text = msg.content[0]?.text || '[]';
    const match = text.match(/\[[\s\S]*\]/);
    const analysis = match ? JSON.parse(match[0]) : [];
    res.status(200).json({ analysis });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
