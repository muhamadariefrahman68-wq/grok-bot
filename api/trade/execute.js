// EXECUTOR LIVE Grok Bot (server-side, Vercel).
// Route:  GET  /api/trade/execute?action=status  -> status aman (TANPA secret)
//         POST /api/trade/execute                 -> eksekusi 1 trade live
//         body: { side:'buy'|'sell', mint, amountUsd, slippageBps }
//         header wajib: x-grokbot-confirm: live-confirmed
//
// ATURAN MUTLAK:
// - Trade live HANYA jalan bila env TRADING_MODE == 'live'. Selain itu route
//   MENOLAK semua POST (403) — Paper adalah default dan tetap aman.
// - Private key dibaca HANYA dari env Vercel SOLANA_WALLET_SECRET di server.
//   Key TIDAK PERNAH dikirim ke browser, TIDAK PERNAH masuk respons / log.
//   Format yang diterima: JSON array 64 byte "[12,34,...]" ATAU string base58.
// - Alur beli: Jupiter Price v3 (harga SOL) -> Jupiter Quote v6 -> Swap v6 ->
//   tanda tangan server -> SIMULASI (simulateTransaction) -> broadcast HANYA
//   bila simulasi bersih. Slippage di-clamp <= 500 bps (5%).
// - Beli dibatasi <= $1.01 per trade (aturan $1 per coin + toleransi pembulatan).
//   Jual = 100% saldo token mint itu di wallet.
// - Audit hard-kill + Smart Score + batas harian ditegakkan di dashboard
//   SEBELUM route ini dipanggil; route ini adalah gerbang terakhir di server.
//
// Dependency: @solana/web3.js + bs58 (lihat package.json di panel Deploy).
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const SOL = 'So11111111111111111111111111111111111111112';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const MAX_SLIP_BPS = 500;      // Safety Rails: slippage maks 5%
const MAX_BUY_USD = 1.01;      // aturan $1 per coin (+ toleransi pembulatan)
const FEE_BUFFER_SOL = 0.002;  // cadangan gas minimum di atas nilai beli

function loadKeypair() {
  const raw = (process.env.SOLANA_WALLET_SECRET || '').trim();
  if (!raw) return null;
  try {
    if (raw.startsWith('[')) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length >= 64) return Keypair.fromSecretKey(Uint8Array.from(arr.slice(0, 64)));
      return null;
    }
    const bytes = bs58.decode(raw);
    if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
    if (bytes.length === 32) return Keypair.fromSeed(bytes);
    return null;
  } catch (_) { return null; }
}

async function solPriceUsd() {
  const r = await fetch('https://api.jup.ag/price/v3?ids=' + SOL, {
    headers: { Accept: 'application/json', 'User-Agent': 'GrokBot/1.0 (+https://onlinejob.web.id)' },
  });
  if (!r.ok) throw new Error('Jupiter Price v3 HTTP ' + r.status);
  const j = await r.json();
  const e = (j && (j[SOL] || (j.data && j.data[SOL]))) || null;
  const px = e ? Number(e.usdPrice != null ? e.usdPrice : e.price) : NaN;
  if (!Number.isFinite(px) || px <= 0) throw new Error('harga SOL tidak tersedia dari Jupiter — fail-closed');
  return px;
}

async function quote(inputMint, outputMint, amountRaw, slippageBps) {
  const u = 'https://quote-api.jup.ag/v6/quote?inputMint=' + inputMint + '&outputMint=' + outputMint
    + '&amount=' + amountRaw + '&slippageBps=' + slippageBps;
  const r = await fetch(u, { headers: { Accept: 'application/json', 'User-Agent': 'GrokBot/1.0 (+https://onlinejob.web.id)' } });
  if (!r.ok) throw new Error('Jupiter Quote v6 HTTP ' + r.status);
  const q = await r.json();
  if (!q || !q.outAmount) throw new Error('Jupiter Quote kosong — tidak ada rute swap, fail-closed');
  return q;
}

async function buildSwapTx(quoteResponse, userPublicKey) {
  const r = await fetch('https://quote-api.jup.ag/v6/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'GrokBot/1.0 (+https://onlinejob.web.id)' },
    body: JSON.stringify({ quoteResponse, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
  });
  if (!r.ok) throw new Error('Jupiter Swap v6 HTTP ' + r.status);
  const j = await r.json();
  if (!j || !j.swapTransaction) throw new Error('Jupiter Swap tidak mengembalikan transaksi — fail-closed');
  return j.swapTransaction;
}

function isAllowedOrigin(req) {
  const origin = req.headers.origin || req.headers.referer || '';
  if (!origin) return true; // curl / server-to-server: tidak ada Origin
  try {
    const host = new URL(origin).hostname;
    return host === 'onlinejob.web.id' || host === 'www.onlinejob.web.id' || host.endsWith('.vercel.app');
  } catch (_) { return false; }
}

export default async function handler(req, res) {
  const mode = (process.env.TRADING_MODE || 'paper').toLowerCase();

  /* ---------- STATUS (GET) — tidak pernah memuat secret ---------- */
  if (req.method === 'GET') {
    const kp = loadKeypair();
    let solBalance = null;
    if (kp) {
      try {
        const conn = new Connection(RPC, 'confirmed');
        solBalance = (await conn.getBalance(kp.publicKey)) / 1e9;
      } catch (_) { solBalance = null; }
    }
    return res.status(200).json({
      ok: true,
      tradingMode: mode,
      liveEnabled: mode === 'live',
      wallet: kp ? kp.publicKey.toBase58() : null,
      secretConfigured: !!kp,
      solBalance,
      maxBuyUsd: MAX_BUY_USD,
      maxSlippageBps: MAX_SLIP_BPS,
      at: new Date().toISOString(),
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  /* ---------- GERBANG LIVE (berlapis, fail-closed) ---------- */
  if (mode !== 'live') {
    return res.status(403).json({ error: 'TRADING_MODE bukan "live" (sekarang: ' + mode + ') — executor menolak semua trade. Bot tetap Paper.' });
  }
  const execToken = process.env.EXECUTOR_TOKEN || '';
  if (!execToken) {
    return res.status(500).json({ error: 'EXECUTOR_TOKEN belum terisi di env Vercel — executor menolak semua trade (fail-closed)' });
  }
  if (req.headers['x-grokbot-token'] !== execToken) {
    return res.status(401).json({ error: 'token executor tidak valid — trade live wajib membawa token EXECUTOR_TOKEN yang sama dengan env server' });
  }
  if (req.headers['x-grokbot-confirm'] !== 'live-confirmed') {
    return res.status(428).json({ error: 'konfirmasi eksplisit tidak ada — trade live wajib dikonfirmasi user di UI (ringkasan chain · wallet · jumlah · slippage · TP/SL)' });
  }
  if (!isAllowedOrigin(req)) {
    return res.status(403).json({ error: 'origin tidak diizinkan' });
  }
  const kp = loadKeypair();
  if (!kp) return res.status(500).json({ error: 'SOLANA_WALLET_SECRET belum terisi / tidak valid di env Vercel — executor tidak bisa tanda tangan' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  const side = body && body.side;
  const mint = body && String(body.mint || '');
  const amountUsd = body ? Number(body.amountUsd) : NaN;
  let slippageBps = body ? Math.floor(Number(body.slippageBps)) : NaN;
  if (side !== 'buy' && side !== 'sell') return res.status(400).json({ error: 'side harus "buy" atau "sell"' });
  if (!BASE58.test(mint) || mint === SOL) return res.status(400).json({ error: 'mint tidak valid' });
  if (!Number.isFinite(slippageBps)) slippageBps = MAX_SLIP_BPS;
  slippageBps = Math.max(10, Math.min(MAX_SLIP_BPS, slippageBps)); // clamp <= 5%
  if (side === 'buy' && (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > MAX_BUY_USD)) {
    return res.status(400).json({ error: 'amountUsd beli wajib 0 < x <= $' + MAX_BUY_USD + ' (aturan $1 per coin)' });
  }

  const conn = new Connection(RPC, 'confirmed');
  try {
    let inMint, outMint, amountRaw, quoteRes;
    if (side === 'buy') {
      const px = await solPriceUsd();
      const lamports = Math.floor((amountUsd / px) * 1e9);
      if (lamports <= 0) throw new Error('nilai beli terlalu kecil terhadap harga SOL');
      const bal = await conn.getBalance(kp.publicKey);
      if (bal < lamports + Math.floor(FEE_BUFFER_SOL * 1e9)) {
        return res.status(422).json({ error: 'saldo SOL tidak cukup untuk beli $' + amountUsd.toFixed(2) + ' + gas (saldo ' + (bal / 1e9).toFixed(6) + ' SOL) — fail-closed' });
      }
      inMint = SOL; outMint = mint; amountRaw = String(lamports);
    } else {
      // JUAL: 100% saldo token mint ini di wallet (raw amount, BigInt aman)
      const accts = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint: new PublicKey(mint) });
      let raw = 0n;
      for (const a of accts.value) {
        const amt = a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info
          && a.account.data.parsed.info.tokenAmount && a.account.data.parsed.info.tokenAmount.amount;
        if (amt) raw += BigInt(String(amt));
      }
      if (raw <= 0n) return res.status(422).json({ error: 'saldo token mint ini 0 di wallet — tidak ada yang bisa dijual' });
      inMint = mint; outMint = SOL; amountRaw = raw.toString();
    }

    /* 1) QUOTE -> 2) SWAP TX -> 3) SIGN -> 4) SIMULASI -> 5) BROADCAST */
    quoteRes = await quote(inMint, outMint, amountRaw, slippageBps);
    const swapB64 = await buildSwapTx(quoteRes, kp.publicKey.toBase58());
    const tx = VersionedTransaction.deserialize(Buffer.from(swapB64, 'base64'));
    tx.sign([kp]);

    const sim = await conn.simulateTransaction(tx);
    if (sim.value && sim.value.err) {
      return res.status(422).json({ error: 'SIMULASI GAGAL — broadcast dibatalkan (fail-closed): ' + JSON.stringify(sim.value.err) });
    }
    const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const latest = await conn.getLatestBlockhash('confirmed');
    await conn.confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, 'confirmed');

    return res.status(200).json({
      ok: true, side, mint, signature,
      wallet: kp.publicKey.toBase58(),
      amountUsd: side === 'buy' ? amountUsd : null,
      inAmount: amountRaw, outAmount: quoteRes.outAmount,
      slippageBps, priceImpactPct: quoteRes.priceImpactPct != null ? quoteRes.priceImpactPct : null,
      at: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({ error: 'executor gagal (fail-closed, tidak ada broadcast paksa): ' + String((e && e.message) || e) });
  }
}
