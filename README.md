# Jupiter Pattern Bot

CLI Solana trading bot that scores **candlestick + volume** setups (solana-skill rules), buys/sells via **Jupiter Swap API** (`api.jup.ag` quote/order + execute — **not** the [jup.ag/yolo](https://jup.ag/yolo) leveraged web UI), exits at **take-profit +50%** / **stop-loss −20%**, and **learns from each close**.

Adapted from [solana-terminal-bot](https://github.com/cannergtfo-commits/solana-terminal-bot). Sibling bots (`solana-terminal-bot`, `olama-trades`) are separate — leave them alone.

> **Not financial advice.** Default `DRY_RUN=true`. Memecoins can go to zero. You can lose funds if you go live. Use tiny test amounts.

## What it does

1. Scans DexScreener / Pump.fun / Jupiter for candidates  
2. Scores OHLCV / proxy candle patterns (`maru_bull`, `3soldiers`, hammer, engulf, …) + volume  
3. Enters when skill gates pass (momentum tag, min score ≥68, preferred stack, cooldown/denylist)  
4. Swaps SOL → token (or reverse) through Jupiter APIs  
5. Monitors open positions for **+50% TP**, **−20% SL**, early-red cut, max hold  
6. Writes lessons to `data/trade-learnings.json` and `data/pending-skill-lessons.jsonl`

## Quick start

```bash
git clone https://github.com/cannergtfo-commits/jupiter-pattern-bot.git
cd jupiter-pattern-bot
npm install
npm run build
npm run init-wallet          # creates .wallet/keypair.json (gitignored) + prints public address
# Fund the PUBLIC address with a little SOL if you later go live — keep DRY_RUN=true first
npm run bot -- status
npm run bot -- bot on
npm run bot -- scan
npm run bot -- run --once    # one dry tick
npm run bot -- dashboard     # TUI
```

**Windows PowerShell** — run `npm` lines separately (no `&&`), or:

```powershell
cmd /c "npm install"
cmd /c "npm run build"
cmd /c "npm run init-wallet"
```

If `npm.ps1` is blocked: `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` once, or always use `cmd /c "…"`.

## Key knobs

| Knob | Default | Notes |
|------|---------|--------|
| `TAKE_PROFIT_PCT` | **50** | Close when unrealized ≥ +50% |
| `STOP_LOSS_PCT` | **20** | Close when unrealized ≤ −20% (flash dumps can gap past) |
| `BUY_AMOUNT_SOL` | 0.05 | Per-entry size (capped by portfolio %) |
| `DRY_RUN` | **true** | Logs Jupiter orders; does not sign/send |
| `MAX_HOLD_MINUTES` | 15 | Time-exit if TP not hit (optional) |
| `EARLY_RED_CUT_MINUTES` | 3 | Exit if still ≤0% after 3m |
| `minPatternScore` | 68 | Soft entry floor |
| `requireMomentumPatternTag` | true | Need `maru_bull` or `3soldiers` |
| `reentryCooldownMinutes` | 10 | After any close on a mint |
| `autoDenylistOnSl` | true | Deny mint after SL |

Edit `config.json` and/or `.env` (copy from `.env.example`). Env overrides file for most strategy keys.

## CLI

```text
npm run init-wallet
npm run bot -- wallet create|address|balance
npm run bot -- scan
npm run bot -- bot on|off|status|tick
npm run bot -- status
npm run bot -- run [--once]
npm run bot -- positions   # via status / dashboard
npm run bot -- dashboard
npm run bot -- web
npm run bot -- history
npm run bot -- setup
```

## Jupiter / RPC

- Swaps use official **Jupiter Swap API v2** (`https://api.jup.ag/swap/v2/…`).  
- Optional `JUPITER_API_KEY` from [portal.jup.ag](https://portal.jup.ag/) reduces rate limits.  
- Prefer a private RPC (`RPC_URL` / Helius) for live use; public mainnet RPC is throttled.  
- This bot does **not** automate the YOLO leveraged UI.

## Learning

On each close the bot appends:

- `data/trade-learnings.json` — structured lessons  
- `data/pending-skill-lessons.jsonl` — one-line pending bullets for skill merges  

These paths are gitignored. Feed reusable lessons back into your solana-skill when you want.

## Secrets — never committed

| Path | Purpose |
|------|---------|
| `.env` | RPC, API keys, strategy overrides |
| `.wallet/keypair.json` | Signing key |
| `data/*.json` / `*.jsonl` | Positions, history, learnings |

## Risk

Experimental software. Stops can gap through on thin liquidity. +50% TP is ambitious vs fees and hold time — many exits will be early-red / time. Always dry-run first.

## License

MIT — see [LICENSE](./LICENSE).
