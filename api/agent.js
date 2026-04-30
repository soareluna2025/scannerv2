function log(msg) {
  console.log(`[agent] ${new Date().toISOString()} ${msg}`);
}

async function callAnthropic(key, messages, maxTokens) {
  const systemMsg = messages.find(m => m.role === 'system')?.content || '';
  const msgs = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, system: systemMsg, messages: msgs })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Anthropic HTTP ${r.status}`);
  return data.content?.[0]?.text || '';
}

async function callGrok(key, messages, maxTokens) {
  const r = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'grok-3-mini', max_tokens: maxTokens, messages })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Grok HTTP ${r.status}`);
  return data.choices?.[0]?.message?.content || '';
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
    return res.status(500).json({ error: 'Niciun API key AI configurat' });
  }

  const body = req.body;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const messages  = body.messages.map(m => ({ role: m.role, content: m.content }));
  const maxTokens = body.max_tokens || 1000;

  let text = '';

  if (anthropicKey) {
    try {
      log('calling Anthropic');
      text = await callAnthropic(anthropicKey, messages, maxTokens);
      log(`Anthropic ok, ${text.length} chars`);
    } catch (e) {
      log(`Anthropic failed: ${e.message} — falling back to Grok`);
      if (!grokKey) return res.status(500).json({ error: e.message });
      try {
        text = await callGrok(grokKey, messages, maxTokens);
        log(`Grok fallback ok, ${text.length} chars`);
      } catch (e2) {
        return res.status(500).json({ error: e2.message });
      }
    }
  } else {
    try {
      log('calling Grok (no Anthropic key)');
      text = await callGrok(grokKey, messages, maxTokens);
      log(`Grok ok, ${text.length} chars`);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(200).json({ choices: [{ message: { content: text } }] });
}
