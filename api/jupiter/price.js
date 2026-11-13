// Jupiter Price API v3 (v2 is dead — returns 404). Server-side so no CORS.
// Route Vercel: GET /api/jupiter/price?ids=<mint[,mint..]>
// Response dinormalisasi ke bentuk v2 yang dikenal dashboard:
//   { data: { "<mint>": { price: "80.02", usdPrice: 80.02 } }, source, upstream, at }
// Harga TIDAK PERNAH dikarang: upstream gagal/kosong = error / data kosong,
// dan dashboard akan FAIL-CLOSED (tidak menebak angka).
const SOL = 'So11111111111111111111111111111111111111112';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  const rawIds = String((req.query && req.query.ids) || SOL);
  const ids = rawIds.split(',').map((s) => s.trim()).filter((s) => BASE58.test(s)).slice(0, 50);
  if (!ids.length) return res.status(400).json({ error: 'ids tidak valid (harus mint Base58)' });
  try {
    const r = await fetch('https://api.jup.ag/price/v3?ids=' + encodeURIComponent(ids.join(',')), {
      headers: { Accept: 'application/json', 'User-Agent': 'GrokBot/1.0 (+https://onlinejob.web.id)' },
    });
    if (!r.ok) return res.status(502).json({ error: 'Jupiter Price API v3 HTTP ' + r.status });
    const j = await r.json();
    const data = {};
    for (const id of ids) {
      const e = (j && (j[id] || (j.data && j.data[id]))) || null;
      const px = e ? Number(e.usdPrice != null ? e.usdPrice : e.price) : NaN;
      if (Number.isFinite(px)) data[id] = { price: String(px), usdPrice: px };
    }
    res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=20');
    return res.status(200).json({ data, source: 'Jupiter Price API v3', upstream: 'https://api.jup.ag/price/v3', at: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ error: 'Jupiter Price API v3 gagal dihubungi dari server: ' + String((e && e.message) || e) });
  }
}
