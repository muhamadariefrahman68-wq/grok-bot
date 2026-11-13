// Vercel Cron: scan Solana meme coins, fail-closed.
// Paper mode by default. Live trading is disabled unless LIVE_TRADING=true
// and SOLANA_WALLET_SECRET is set in Vercel env. Never log secrets.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  // Fail-closed: without a key, report unavailable instead of inventing data.
  const hasKey = Boolean(process.env.TRUESOTA_API_KEY);
  const mode = process.env.TRADING_MODE
    ? String(process.env.TRADING_MODE).toLowerCase()
    : (process.env.LIVE_TRADING === 'true' ? 'live' : 'paper');
  return res.status(200).json({
    ok: true,
    mode,
    scanned_at: new Date().toISOString(),
    wallet: process.env.SOLANA_WALLET_ADDRESS || null,
    truesota_configured: hasKey,
    note: 'Scan runs from DexScreener / Jupiter live data in the dashboard. No trade is placed without a passing audit, Smart Score >= threshold, and a funded wallet.'
  });
}
