// Vercel Cron scanner — Grok Bot PRO (server-side).
// HANYA memindai + menilai; TIDAK PERNAH trade. Eksekusi live hanya lewat
// route /api/trade/execute setelah konfirmasi eksplisit user di UI.
// Semua angka WAJIB dari respons API asli (DexScreener / Jupiter / Solana RPC)
// lengkap dengan sumber + waktu. Data kosong/basi/error = SKIP (fail-closed).
// Auth: bila env CRON_SECRET di-set, Vercel Cron mengirim
// Authorization: Bearer <CRON_SECRET> dan route menolak tanpa token itu.
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const DEFAULT_WALLET = 'EJrjGUTe2qNok3GRHDcQi8kR56tn7Q7ymHgx2eBcyeMY';
const SOL = 'So11111111111111111111111111111111111111112';

const RULES = {
  minVolume1h: 30000,
  minLiquidityUsd: 10000,
  maxTop10Pct: 20,
  smartThreshold: 0.65,
  maxSlippageBps: 500,
};
// Bobot Smart Score faktor TERUKUR (sosial/buzz dikeluarkan karena X/Telegram
// belum terhubung — bobot dinormalisasi ke 100%, sama seperti scan live di UI).
const WEIGHTS = { liq: 20, vol: 15, holder: 15, dev: 15, age: 10, curve: 10 };
const W_SUM = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.json();
}

async function rpc(method, params) {
  const j = await fetchJson(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (j.error) throw new Error('RPC ' + (j.error.message || 'error'));
  return j.result;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

async function evaluate(mint, now) {
  const rec = { mint, at: now, sources: {}, verdict: 'SKIP', reasons: [] };
  try {
    const dex = await fetchJson('https://api.dexscreener.com/latest/dex/tokens/' + encodeURIComponent(mint));
    const pairs = ((dex && dex.pairs) || []).filter((p) => p.chainId === 'solana');
    if (!pairs.length) { rec.reasons.push('DexScreener: tidak ada pair Solana — data belum tersedia'); return rec; }
    pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
    const p = pairs[0];
    const price = parseFloat(p.priceUsd);
    const liq = p.liquidity && p.liquidity.usd != null ? p.liquidity.usd : null;
    const vol1 = p.volume && p.volume.h1 != null ? p.volume.h1 : null;
    const ageMs = p.pairCreatedAt ? Date.now() - p.pairCreatedAt : null;
    if (!isFinite(price) || liq === null || vol1 === null || ageMs === null || ageMs < 0) {
      rec.reasons.push('data inti tidak lengkap (harga/likuiditas/volume/umur pair) — data belum tersedia');
      return rec;
    }
    const ageDays = ageMs / 864e5;
    const cat = ageDays > 7 ? 'old' : 'new';
    rec.sym = '$' + ((p.baseToken && p.baseToken.symbol) || mint.slice(0, 4));
    rec.cat = cat;
    rec.sources.dexscreener = { at: now, priceUsd: price, liquidityUsd: liq, volumeH1: vol1, pairCreatedAt: p.pairCreatedAt };
    if (liq < RULES.minLiquidityUsd) { rec.verdict = 'KILL'; rec.reasons.push('audit LP-drain/sandwich · likuiditas $' + liq + ' < ambang $' + RULES.minLiquidityUsd); return rec; }
    if (vol1 < RULES.minVolume1h) { rec.reasons.push('volume 1 jam $' + vol1 + ' di bawah ambang $' + RULES.minVolume1h); return rec; }

    const info = (await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]))?.value?.data?.parsed?.info;
    if (!info) { rec.reasons.push('Solana RPC: mint tidak ditemukan — data belum tersedia'); return rec; }
    rec.sources.solanaRpc = { at: now, mintAuthority: info.mintAuthority, freezeAuthority: info.freezeAuthority };
    if (info.mintAuthority || info.freezeAuthority) {
      rec.verdict = 'KILL'; rec.reasons.push('audit authority · mint/freeze authority masih AKTIF (wajib None/None)'); return rec;
    }
    const [largest, supply] = await Promise.all([
      rpc('getTokenLargestAccounts', [mint]),
      rpc('getTokenSupply', [mint]),
    ]);
    const sup = parseFloat(supply?.value?.uiAmountString || '0');
    const accts = (largest && largest.value) || [];
    if (!accts.length || !sup) { rec.reasons.push('data holder tidak lengkap di RPC — data belum tersedia'); return rec; }
    let sum10 = 0;
    accts.slice(0, 10).forEach((a) => { sum10 += parseFloat(a.uiAmountString || '0'); });
    const top10 = (sum10 / sup) * 100;
    rec.sources.holders = { at: now, top10Pct: top10 };
    if (top10 > RULES.maxTop10Pct) {
      rec.verdict = 'KILL'; rec.reasons.push('audit holder · top 10 = ' + top10.toFixed(1) + '% > 20%'); return rec;
    }

    // Skor dari faktor terukur saja (sosial/buzz tidak ditebak).
    const f = {
      liq: clamp01((Math.log10(Math.max(liq, 1)) - 4) / 2),
      vol: clamp01(vol1 / (RULES.minVolume1h * 3)),
      holder: clamp01((30 - top10) / 25),
      dev: 0.95,
      age: cat === 'new'
        ? (ageMs / 36e5 < 0.25 ? 0.25 : clamp01(0.35 + ((ageMs / 36e5) / 24) * 0.65))
        : Math.min(1, 0.45 + Math.log10(Math.max(1, ageDays)) * 0.28),
      curve: 0.5,
    };
    const tx = (p.txns && p.txns.h1) || null;
    if (tx && (tx.buys + tx.sells) > 0) {
      const ratio = tx.buys / (tx.buys + tx.sells);
      f.curve = clamp01((ratio - 0.2) / 0.6) * ((tx.buys + tx.sells) >= 20 ? 1 : 0.5);
    }
    let total = 0;
    for (const k of Object.keys(WEIGHTS)) total += f[k] * (WEIGHTS[k] / W_SUM);
    rec.score = Math.round(total * 100) / 100;
    rec.factors = f;
    rec.verdict = total >= RULES.smartThreshold ? 'PASS' : 'SKIP';
    if (rec.verdict === 'SKIP') rec.reasons.push('Smart Score ' + rec.score.toFixed(2) + ' < ambang ' + RULES.smartThreshold);
    else rec.reasons.push('lolos audit + Smart Score ' + rec.score.toFixed(2) + ' ≥ ' + RULES.smartThreshold + ' (paper; live butuh konfirmasi UI)');
    return rec;
  } catch (e) {
    rec.reasons.push('FAIL-CLOSED: ' + String((e && e.message) || e));
    return rec;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  if (process.env.CRON_SECRET && req.headers.authorization !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const now = new Date().toISOString();
  const mode = process.env.TRADING_MODE
    ? String(process.env.TRADING_MODE).toLowerCase()
    : (process.env.LIVE_TRADING === 'true' ? 'live' : 'paper');
  const wallet = process.env.SOLANA_WALLET_ADDRESS || DEFAULT_WALLET;

  let walletSol = null;
  try {
    const b = await rpc('getBalance', [wallet]);
    walletSol = typeof b?.value === 'number' ? b.value / 1e9 : null;
  } catch (_) { walletSol = null; }

  let solPriceUsd = null;
  try {
    const j = await fetchJson('https://api.jup.ag/price/v3?ids=' + SOL);
    const e = j && j[SOL];
    solPriceUsd = e ? Number(e.usdPrice) : null;
  } catch (_) { solPriceUsd = null; }

  const liveAllowed = mode === 'live' && walletSol !== null && walletSol > 0;
  const results = [];
  try {
    const [profiles, boosts] = await Promise.all([
      fetchJson('https://api.dexscreener.com/token-profiles/latest/v1').catch(() => []),
      fetchJson('https://api.dexscreener.com/token-boosts/top/v1').catch(() => []),
    ]);
    const seen = new Set();
    const fresh = (Array.isArray(profiles) ? profiles : [])
      .filter((p) => p && p.chainId === 'solana' && p.tokenAddress && !seen.has(p.tokenAddress))
      .slice(0, 6);
    fresh.forEach((p) => seen.add(p.tokenAddress));
    const established = (Array.isArray(boosts) ? boosts : [])
      .filter((p) => p && p.chainId === 'solana' && p.tokenAddress && !seen.has(p.tokenAddress))
      .slice(0, 4);
    for (const p of [...fresh, ...established]) {
      results.push(await evaluate(p.tokenAddress, now));
    }
  } catch (e) {
    return res.status(200).json({
      ok: false, failClosed: true, reason: 'DexScreener gagal: ' + e.message,
      at: now, mode, paper: !liveAllowed, wallet, walletSol, solPriceUsd, scanned: 0, results,
    });
  }
  return res.status(200).json({
    ok: true, at: now, mode, paper: !liveAllowed, wallet, walletSol, solPriceUsd,
    scanned: results.length,
    passed: results.filter((r) => r.verdict === 'PASS').length,
    rules: RULES, weights: WEIGHTS,
    note: 'Scanner saja — tidak ada trade dari cron. Trade live hanya lewat /api/trade/execute setelah konfirmasi eksplisit di UI.',
    results,
  });
}
