# Jupiter Pattern Bot

CLI pattern scanner + risk-managed trader. Scores **candlestick + volume** (solana-skill), prints **LONG / SHORT / DO NOTHING** every **30s**, defaults to **DRY_RUN**.

> **Not financial advice.** Memecoins and **YOLO leverage** can go to zero instantly. Keep `DRY_RUN=true` until you understand the risks.

## Venues

| Venue | How | Long | Short |
|-------|-----|------|-------|
| **spot** (default historically) | Jupiter Swap API | Yes | Signal-only |
| **yolo** (`TRADE_VENUE=yolo`) | Brittle Playwright on [jup.ag/yolo](https://jup.ag/yolo/?market=SOL&mode=classic) | Yes | Yes |

See **[docs/YOLO.md](./docs/YOLO.md)** for API reality, fragility, and live opt-in (`YOLO_LIVE`).

## Defaults

| Knob | Value |
|------|--------|
| Scan | every **30s** → LONG / SHORT / DO NOTHING |
| TP / SL | **+50%** / **−20%** (YOLO: collateral PnL % ≈ price×leverage) |
| Max hold | **40 seconds** hard |
| Position poll | **5s** |
| DRY_RUN | **true** |
| YOLO size | **5** JupUSD collateral @ **500x** (minimum / lowest lev) |

## Quick start

```bash
git clone https://github.com/cannergtfo-commits/jupiter-pattern-bot.git
cd jupiter-pattern-bot
npm install
npx playwright install chromium    # for YOLO browser dry-run
npm run build
npm run init-wallet                # prints PUBLIC address only
npm run bot -- status
```

### YOLO dry-run (browser, no signing)

```bash
npm run bot -- yolo dry-run --seconds 90
npm run bot -- yolo status
```

### Mark-proxy paper (no browser)

5–15 minute sessions. Scans every 30s (LONG/SHORT/DO NOTHING), TP+50%/SL−20%, hard close 40s. Writes `data/paper-yolo-session.json` + `data/paper-learnings.jsonl`. See **[docs/PAPER.md](./docs/PAPER.md)**.

```bash
npm run paper                         # 5 min
npm run paper -- --minutes 10
npm run paper -- --minutes 15 --force-min 4
npm run bot -- yolo paper --minutes 10
```

### Spot loop (Jupiter swap API)

```bash
npm run bot -- bot on
npm run bot -- run                 # 30s loop + 5s polls (dry)
```

**Withdraw SOL** (preview then confirm):

```bash
npm run bot -- wallet withdraw <DEST_PUBKEY> <AMOUNT_SOL>       # preview
npm run bot -- wallet withdraw <DEST_PUBKEY> <AMOUNT_SOL> --yes # confirm
```

**Encrypt wallet** (optional): set `WALLET_PASSWORD` in `.env`, then `npm run bot -- wallet encrypt`.

## Security

| Path | Purpose |
|------|---------|
| `.wallet/keypair.json` | Secret array, mode **0600** (if no password) |
| `.wallet/keystore.json` | AES-256-GCM encrypted secret (if `WALLET_PASSWORD`) |
| `.wallet/address.txt` | Public address only |
| `.env` | RPC / keys / password — **gitignored** |

Never commit `.wallet/` or paste the private key into chat. YOLO LIVE never injects the key into Chromium — connect a wallet in a persistent profile yourself.

## CLI

```text
npm run init-wallet
npm run bot -- wallet create|encrypt|address|balance|withdraw
npm run bot -- scan | run [--once] | status | history
npm run bot -- bot on|off|status|tick
npm run bot -- yolo dry-run|run|status|paper
npm run bot -- dashboard | web | setup
npm run paper
npm run yolo:dry-run
```

## Related products

- Spot Swap API: https://developers.jup.ag/docs/swap  
- Perps API (long/short, not YOLO): https://perps-api.jup.ag/v1/docs  
- YOLO UI: https://jup.ag/yolo  
- YOLO docs: https://docs.jup.ag/user-docs/labs/yolo/trading  

## License

MIT
