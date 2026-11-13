// Solana RPC proxy — server-side so the browser is never blocked (HTTP 403 / CORS).
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const body = req.body || {};
  try {
    const r = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: body.method, params: body.params || [] })
    });
    const data = await r.json();
    if (data.error) return res.status(200).json({ ok: false, error: data.error.message || 'RPC error' });
    return res.status(200).json({ ok: true, result: data.result });
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'rpc fetch failed' });
  }
}
