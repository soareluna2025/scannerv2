function log(msg) {
  console.log(`[telegram] ${new Date().toISOString()} ${msg}`);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token   = process.env.TELEGRAM_BOT_TOKEN;
  const chatId  = process.env.TELEGRAM_CHAT_ID;

  if (!token)  return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN neconfigurat' });
  if (!chatId) return res.status(500).json({ error: 'TELEGRAM_CHAT_ID neconfigurat' });

  const { message, chat_id } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

  const target = chat_id || chatId;

  try {
    log(`sending to ${target}: ${message.substring(0, 60)}...`);
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    target,
        text:       message,
        parse_mode: 'HTML'
      })
    });

    const data = await r.json();
    if (!data.ok) {
      log(`Telegram error: ${data.description}`);
      return res.status(400).json({ error: data.description });
    }

    log(`sent OK (message_id: ${data.result?.message_id})`);
    return res.status(200).json({ ok: true, message_id: data.result?.message_id });
  } catch (e) {
    log(`ERROR: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
}
