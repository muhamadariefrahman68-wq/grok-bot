// Returns the model list from TrueSOTA (https://true-sota.com/v1).
// Prefers grok-4.6, falls back to qwen3.8-max if grok-4.6 is not listed.
export default async function handler(req, res) {
  const key = process.env.TRUESOTA_API_KEY;
  if (!key) return res.status(200).json({ ok: false, error: 'TRUESOTA_API_KEY not configured', models: [] });
  try {
    const r = await fetch('https://true-sota.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!r.ok) return res.status(200).json({ ok: false, error: 'TrueSOTA HTTP ' + r.status, models: [] });
    const data = await r.json();
    const ids = (data.data || []).map((m) => m.id);
    const active = ids.includes('grok-4.6') ? 'grok-4.6' : (ids.includes('qwen3.8-max') ? 'qwen3.8-max' : ids[0] || null);
    return res.status(200).json({ ok: true, models: ids, active });
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'models fetch failed', models: [] });
  }
}
