# Paper sessions (mark-proxy YOLO)

No browser, no wallet, no signing. Uses **spot SOL/USD** as a YOLO mark proxy and `scanSolForYolo` (solana-skill candles + volume) for **LONG / SHORT / DO NOTHING**.

| Knob | Default |
|------|---------|
| Scan | every **30s** |
| TP / SL | **+50%** / **−20%** collateral PnL ≈ `priceMove% × leverage` |
| Max hold | **40s** hard close |
| Leverage | **500x** (paper only) |
| Collateral | **5** (units) |
| Duration | **5** minutes (`--minutes 5..15`) |

At 500x, a **0.1%** adverse move ≈ **−50%** collateral — paper % is hypersensitive. Treat results as signal/timing practice, not realistic YOLO fills.

## Run (5–15 minutes)

```bash
cd jupiter-pattern-bot
npm install   # once

# 5 minutes (default)
npm run paper

# 10 or 15 minutes
npm run paper -- --minutes 10
npm run paper -- --minutes 15

# Force at least N paper trades if signals are quiet
npm run paper -- --minutes 10 --force-min 4

# Same via CLI wrapper
npm run bot -- yolo paper --minutes 10
```

Env overrides (optional): `PAPER_MINUTES`, `PAPER_DURATION_MS`, `PAPER_TP_PCT`, `PAPER_SL_PCT`, `PAPER_LEVERAGE`, `PAPER_COLLATERAL`, `PAPER_FORCE_MIN`, `PAPER_MAX_HOLD_SEC`, `PAPER_SCAN_SEC`, `PAPER_POLL_SEC`.

## Outputs

| Path | What |
|------|------|
| `data/paper-yolo-session.json` | Latest session summary (overwritten each run) |
| `data/paper-<iso-timestamp>.json` | Stamped copy of that session |
| `data/paper-learnings.jsonl` | Append-only lesson per closed trade |

All under `data/` are **gitignored** (except `.gitkeep`). Never commit `.env` or `.wallet/`.

## What “short” means here

Paper **SHORT** is a real paper position vs the mark (PnL flips with price). Live YOLO shorts need the browser driver (`npm run yolo:dry-run`). Spot Jupiter swaps cannot short.

## Safety

- Always dry — this script never loads the keypair or clicks YOLO.
- Keep `DRY_RUN=true` in `.env` for the main bot.
- Do not fund a wallet for paper sessions.
