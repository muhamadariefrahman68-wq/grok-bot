# Grok Bot

Solana meme coin paper trading dashboard — Grok Bot RM, strict RM, paper → live.

- Dashboard: `index.html` (static, replay of the video night run $280 → $3,412 labelled REPLAY)
- 6 agents: Scout, Filter, Analyst, Executor, Risk, Logger
- Single-position rotation: $1 per coin, TP +50%/+100% or SL -30% (rotation SL = `S.stop`, default 30, user-changeable via "Hard stop — SL rotasi"; the video replay's own stop is a separate constant −6% and never drives rotation), then auto-scan next coin
- Smart Score = weighted sum of factors, no hidden adjustments
- Wallet: Jupiter Wallet (Solana), swaps via Jupiter API
- Domain: http://onlinejob.web.id/
- Hosting: Vercel only

## Vercel Cron (Hobby: daily only)

- `vercel.json`: `0 0 * * *` (00:00 UTC / 07:00 WIB) → `GET /api/cron/scan`
- `api/cron/scan.js` is a REAL scanner (not a stub): DexScreener token-profiles
  (new coins) + token-boosts (established coins) → per-candidate DexScreener
  pairs + Solana RPC (mint/freeze authority, top-10 holders) → hard-kill audit
  → Smart Score from measurable factors only. **It never trades.**
- Optional `CRON_SECRET` env: when set, the route requires
  `Authorization: Bearer <CRON_SECRET>`.

## Live executor (server-side)

- `api/trade/execute.js` — the only trade path. Contract (must match the UI):
  - `GET /api/trade/execute?action=status` →
    `{ ok, tradingMode, liveEnabled, wallet, secretConfigured, solBalance,
       maxBuyUsd, maxSlippageBps, at }` (never contains a secret)
  - `POST /api/trade/execute` with header `x-grokbot-confirm: live-confirmed`
    and body `{ side: 'buy'|'sell', mint, amountUsd, slippageBps }` →
    `{ ok, side, mint, signature, ... }`
  - Refuses every POST unless env `TRADING_MODE` is `live` (default Paper).
  - Buy ≤ $1.01 per trade (converted with live Jupiter Price v3 SOL price);
    sell = 100% of the wallet's balance of that mint.
  - Slippage clamped to ≤ 500 bps (5%). Flow: Jupiter Quote v6 → Swap v6 →
    server signs with `SOLANA_WALLET_SECRET` → `simulateTransaction` →
    broadcast ONLY if the simulation is clean.
  - Needs `package.json` (`@solana/web3.js` + `bs58`) deployed.
- `api/jupiter/price.js` — Jupiter Price API **v3** (v2 is dead, 404), multi-id,
  Base58 validation, max 50 ids, GET only.
- `api/solana/rpc.js` — read-only RPC allowlist only
  (`getBalance`, `getAccountInfo`, `getTokenLargestAccounts`, `getTokenSupply`,
  `getSlot`, `getBlockHeight`, `getVersion`); no `sendTransaction`, no key.
- `api/llm/models.js` — TrueSOTA model list via server env key; checks `r.ok`
  and returns `ok:false` + upstream status on error. The browser Test button
  calls `/api/llm/models` — it never fetches true-sota.com directly (CORS).

## Env vars (Vercel → Settings → Environment Variables)

Only these are read by the deployed code. Do not add unused vars.

- `TRUESOTA_API_KEY` — TrueSOTA API key from https://true-sota.com/v1 (model grok-4.6, fallback qwen3.8-max). Never commit a key. The browser NEVER stores it (no localStorage) and never sends it; Test Koneksi uses the server env key via `/api/llm/models`.
- `TRADING_MODE` — `paper` (default, safe) or `live`. Executor refuses all trades unless this is `live`.
- `LIVE_TRADING` — legacy fallback when `TRADING_MODE` is unset (`true` = live).
- `SOLANA_WALLET_ADDRESS` — `EJrjGUTe2qNok3GRHDcQi8kR56tn7Q7ymHgx2eBcyeMY`
- `SOLANA_WALLET_SECRET` — private key for live auto-trading only, as a Vercel env var. Never in chat, never in git. JSON array of 64 bytes or base58.
- `WALLET_PROVIDER` — `jupiter` (documented choice; currently NOT read by code).
- `CRON_SECRET` — optional, protects `/api/cron/scan`.
- `SOLANA_RPC_URL` — optional custom RPC; default `https://api.mainnet-beta.solana.com`.

NOT read by deployed code (do not set): `TRUESOTA_BASE_URL`, `GROK_MODEL`,
`PAPER_MODE`, `JUPITER_API`, `MAX_SLIPPAGE_BPS`.

Paper mode runs with no wallet and no key. Live mode is off until the wallet is funded (SOL for gas + $1 capital) and explicitly enabled.

## Notes

- Daily trading limits (loss limit, profit target, max trades/day, max
  consecutive losses, active hours) are enforced in free-run/live scan only;
  the video replay is a historical simulation and is labelled as such — its
  trades are not counted toward daily limits.
- The Deploy panel in `index.html` embeds downloadable copies of
  `vercel.json`, `api/*.js` and `package.json` — they are regenerated from
  these real files (see `/tmp/regenerate_deploy.py`).
