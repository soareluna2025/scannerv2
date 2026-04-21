import Anthropic from '@anthropic-ai/sdk';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY neconfigurat' });

  const body = req.body;
  if (!body || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Extract system prompt if first message has role 'system'
  let system = '';
  let messages = body.messages;
  if (messages[0]?.role === 'system') {
    system = messages[0].content;
    messages = messages.slice(1);
  }

  // Convert OpenAI image_url format → Anthropic image format
  messages = messages.map(msg => {
    if (!Array.isArray(msg.content)) return msg;
    return {
      ...msg,
      content: msg.content.map(part => {
        if (part.type === 'image_url' && part.image_url?.url) {
          const m = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
          if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
        }
        return part;
      })
    };
  });

  const client = new Anthropic({ apiKey: key });

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: body.max_tokens || 800,
      system: system || undefined,
      messages
    });
    res.status(200).json(response);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
