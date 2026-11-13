// Solana RPC proxy — server-side so the browser is never blocked (HTTP 403 / CORS).
// Security: read-only allowlist only. No sendTransaction / sign / write method
// can ever pass through this route, and no private key lives here.
// Optional env SOLANA_RPC_URL for a private RPC provider (Helius/QuickNode).
const UPSTREAM = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const ALLOWED = new Set([
  'getBalance',
  'getAccountInfo',
  'getTokenLargestAccounts',
  'getTokenSupply',
  'getSlot',
  'getBlockHeight',
  'getVersion',
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = null; }
  }
  const method = body && body.method;
  if (!body || !ALLOWED.has(method)) {
    return res.status(400).json({ ok: false, error: 'method RPC tidak diizinkan di route ini: ' + String(method || '(kosong)') });
  }
  const params = Array.isArray(body.params) ? body.params : [];
  if (params.length > 4) {
    return res.status(400).json({ ok: false, error: 'params terlalu banyak (maks 4)' });
  }
  try {
    const r = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'GrokBot/1.0 (+https://onlinejob.web.id)' },
      body: JSON.stringify({ jsonrpc: '2.0', id: body.id != null ? body.id : 1, method, params }),
    });
    if (!r.ok) return res.status(502).json({ ok: false, error: 'Solana RPC HTTP ' + r.status });
    const data = await r.json();
    if (data.error) return res.status(200).json({ ok: false, error: data.error.message || 'RPC error' });
    return res.status(200).json({ ok: true, result: data.result });
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'rpc fetch failed' });
  }
}
