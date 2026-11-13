# Grok Bot

Solana meme coin paper trading dashboard — Grok Bot RM, strict RM, paper → live.

- Dashboard: `index.html` (static, replay of the video night run $280 → $3,412 labelled REPLAY)
- 6 agents: Scout, Filter, Analyst, Executor, Risk, Logger
- Single-position rotation: $1 per coin, TP +50%/+100% or SL -30%, then auto-scan next coin
- Smart Score = weighted sum of factors, no hidden adjustments
- Wallet: Jupiter Wallet (Solana), swaps via Jupiter API
- Domain: http://onlinejob.web.id/
- Hosting: Vercel only

## Env vars (Vercel → Settings → Environment Variables)

- `TRUESOTA_API_KEY` — TrueSOTA API key from https://true-sota.com/v1 (model grok-4.6, fallback qwen3.8-max). Never commit a key.
- `SOLANA_WALLET_ADDRESS` — `EJrjGUTe2qNok3GRHDcQi8kR56tn7Q7ymHgx2eBcyeMY`
- `SOLANA_WALLET_SECRET` — private key for live auto-trading only, as a Vercel env var. Never in chat, never in git.

Paper mode runs with no wallet and no key. Live mode is off until the wallet is funded (SOL for gas + $1 capital) and explicitly enabled.
