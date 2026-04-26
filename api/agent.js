function log(msg) {
  console.log(`[agent] ${new Date().toISOString()} ${msg}`);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    log('ERROR: ANTHROPIC_API_KEY not set');
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const body = req.body;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Separate system message from conversation messages (Anthropic requires this)
  const systemMsg = body.messages.find(m => m.role === 'system')?.content || '';
  const messages  = body.messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role, content: m.content }));

  if (messages.length === 0) {
    return res.status(400).json({ error: 'No user/assistant messages provided' });
  }

  try {
    log(`calling Anthropic (${messages.length} messages)`);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         key,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: body.max_tokens || 1000,
        system:     systemMsg,
        messages:   messages
      })
    });

    const data = await r.json();
    if (!r.ok) {
      log(`Anthropic error ${r.status}: ${JSON.stringify(data)}`);
      return res.status(r.status).json({ error: data.error?.message || 'Anthropic API error' });
    }

    const text = data.content?.[0]?.text || '';
    log(`response length: ${text.length} chars`);

    // Return in OpenAI-compatible format so frontend works unchanged
    return res.status(200).json({
      choices: [{ message: { content: text } }]
    });

  } catch (e) {
    log(`ERROR: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
}
