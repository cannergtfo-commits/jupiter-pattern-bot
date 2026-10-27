# Jupiter Pattern Bot

CLI pattern scanner + risk-managed trader. Scores **candlestick + volume** (solana-skill), prints **LONG / SHORT / DO NOTHING** every **30s**, defaults to **DRY_RUN**.

> **Not financial advice.** Memecoins and leverage can go to zero. Keep `DRY_RUN=true` until you understand the risks.

## YOLO reality (important)

**Jupiter YOLO has no public API.** See [docs/YOLO.md](./docs/YOLO.md). This bot does **not** silently open YOLO shorts via spot swaps.

- **SHORT** recommendations are **signal-only** unless you later approve browser YOLO or Jupiter Perps API wiring.
- Spot path may open **LONG** only (buy via Jupiter Swap API) when recommendation is LONG and filters pass.
- YOLO itself is 500x–1,000x, **no native TP/SL**, bust on ~0.1–0.2% adverse move — extreme risk.

## Defaults

| Knob | Value |
|------|--------|
| Scan | every **30s** → print LONG / SHORT / DO NOTHING |
| TP / SL | **+50%** / **−20%** (spot positions; if hit before max hold) |
| Max hold | **40 seconds** hard |
| Position poll | **5s** |
| DRY_RUN | **true** |
| Buy size | 0.05 SOL (spot) |

## Quick start

```bash
git clone https://github.com/cannergtfo-commits/jupiter-pattern-bot.git
cd jupiter-pattern-bot
npm install
npm run build
npm run init-wallet          # prints PUBLIC address only
npm run bot -- status
npm run bot -- bot on
npm run bot -- scan          # one scan + recommendation
npm run bot -- run           # 30s loop + 5s position polls (dry)
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

Never commit `.wallet/` or paste the private key into chat.

## CLI

```text
npm run init-wallet
npm run bot -- wallet create|encrypt|address|balance|withdraw
npm run bot -- scan | run [--once] | status | history
npm run bot -- bot on|off|status|tick
npm run bot -- dashboard | web | setup
```

## Related products (not the same)

- Spot Swap API: https://developers.jup.ag/docs/swap  
- Perps API (long/short, not YOLO): https://perps-api.jup.ag/v1/docs  
- YOLO UI: https://jup.ag/yolo  

## License

MIT
