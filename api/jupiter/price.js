// Jupiter Price API v3 (v2 is dead — returns 404). Server-side so no CORS.
export default async function handler(req, res) {
  const ids = (req.query && req.query.ids) || 'So11111111111111111111111111111111111111112';
  try {
    const r = await fetch('https://api.jup.ag/price/v3?ids=' + encodeURIComponent(ids));
    if (!r.ok) return res.status(200).json({ ok: false, error: 'Jupiter HTTP ' + r.status, models: [] });
    const data = await r.json();
    const d = data && data['So11111111111111111111111111111111111111112'];
    const price = d && parseFloat(d.usdPrice);
    if (!price) return res.status(200).json({ ok: false, error: 'price missing', models: [] });
    return res.status(200).json({ ok: true, price, data });
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'jupiter fetch failed', models: [] });
  }
}
