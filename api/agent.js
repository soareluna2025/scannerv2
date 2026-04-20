export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.GROQ_KEY;
  if (!key) return res.status(500).json({ error: 'GROQ_KEY neconfigurat' });

  try {
    const body = req.body;
    if (!body || !Array.isArray(body.messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        model: body.model || 'llama-3.3-70b-versatile',
        messages: body.messages,
        max_tokens: body.max_tokens || 800,
        temperature: body.temperature ?? 0.7,
        stream: false
      })
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
