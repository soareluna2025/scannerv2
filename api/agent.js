function log(msg) {
  console.log(`[agent] ${new Date().toISOString()} ${msg}`);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.XAI_API_KEY;
  if (!key) {
    log('ERROR: XAI_API_KEY not set');
    return res.status(500).json({ error: 'XAI_API_KEY not configured' });
  }

  const body = req.body;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Pass messages as-is (Grok uses OpenAI-compatible format with system role in messages array)
  const messages = body.messages.map(m => ({ role: m.role, content: m.content }));

  try {
    log(`calling Grok (${messages.length} messages)`);
    const r = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        model:      'grok-3-mini',
        max_tokens: body.max_tokens || 1000,
        messages
      })
    });

    const data = await r.json();
    if (!r.ok) {
      log(`Grok error ${r.status}: ${JSON.stringify(data)}`);
      return res.status(r.status).json({ error: data.error?.message || 'Grok API error' });
    }

    const text = data.choices?.[0]?.message?.content || '';
    log(`response length: ${text.length} chars`);

    return res.status(200).json({
      choices: [{ message: { content: text } }]
    });

  } catch (e) {
    log(`ERROR: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
}
