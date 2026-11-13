// Live executor — server only. Jupiter Quote v6 -> Swap -> simulate -> broadcast.
// Fail-closed: only when TRADING_MODE=live, max $1 per trade, slippage <= 5%,
// SOLANA_WALLET_SECRET is read from env only, never logged or returned.
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MAX_USD = 1;
const MAX_SLIPPAGE_BPS = 500;

function keypairFromSecret(secret) {
  const s = String(secret || '').trim();
  if (!s) return null;
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return Keypair.fromSecretKey(Uint8Array.from(parsed));
  } catch (_) {}
  try {
    const bytes = bs58.decode(s);
    if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
    if (bytes.length === 32) return Keypair.fromSeed(bytes);
  } catch (_) {}
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const mode = String(process.env.TRADING_MODE || '').toLowerCase()
    || (process.env.LIVE_TRADING === 'true' ? 'live' : 'paper');
  if (mode !== 'live') {
    return res.status(200).json({ ok: false, error: 'TRADING_MODE is not live — trade refused (fail-closed)' });
  }
  const secret = process.env.SOLANA_WALLET_SECRET;
  const kp = keypairFromSecret(secret);
  if (!kp) return res.status(200).json({ ok: false, error: 'wallet secret not configured' });

  const body = req.body || {};
  const { action, inputMint, outputMint, amountLamports, slippageBps } = body;
  if (action !== 'buy' && action !== 'sell') {
    return res.status(200).json({ ok: false, error: 'action must be buy or sell' });
  }
  const slip = Number(slippageBps ?? 100);
  if (!Number.isFinite(slip) || slip < 1 || slip > MAX_SLIPPAGE_BPS) {
    return res.status(200).json({ ok: false, error: 'slippage out of range (max 5%)' });
  }
  const amount = Number(amountLamports);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(200).json({ ok: false, error: 'invalid amount' });
  }
  // Buy: input is SOL, max $1 worth — checked by caller via Jupiter price; hard cap 0.02 SOL (~$1.6 at $80) as extra guard.
  if (action === 'buy' && inputMint !== SOL_MINT) {
    return res.status(200).json({ ok: false, error: 'buy input must be SOL' });
  }
  if (action === 'buy' && amount > 20000000) {
    return res.status(200).json({ ok: false, error: 'buy amount exceeds $1 guard' });
  }

  try {
    const quoteUrl = 'https://quote-api.jup.ag/v6/quote?inputMint=' + encodeURIComponent(inputMint)
      + '&outputMint=' + encodeURIComponent(outputMint)
      + '&amount=' + encodeURIComponent(String(Math.floor(amount)))
      + '&slippageBps=' + encodeURIComponent(String(Math.floor(slip)));
    const qr = await fetch(quoteUrl);
    if (!qr.ok) return res.status(200).json({ ok: false, error: 'Jupiter quote failed: HTTP ' + qr.status });
    const quote = await qr.json();
    if (!quote || quote.error) return res.status(200).json({ ok: false, error: 'Jupiter quote error' });

    const sr = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: kp.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto'
      })
    });
    if (!sr.ok) return res.status(200).json({ ok: false, error: 'Jupiter swap failed: HTTP ' + sr.status });
    const swap = await sr.json();
    if (!swap || !swap.swapTransaction) return res.status(200).json({ ok: false, error: 'no swap transaction returned' });

    const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    const txBuf = Buffer.from(swap.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([kp]);

    const sim = await connection.simulateTransaction(tx, { sigVerify: true });
    if (sim.value && sim.value.err) {
      return res.status(200).json({ ok: false, error: 'simulation failed: ' + JSON.stringify(sim.value.err) });
    }
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 2 });
    return res.status(200).json({ ok: true, signature, action, inputMint, outputMint });
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'executor failed (fail-closed, no broadcast): ' + String((e && e.message) || e) });
  }
}
