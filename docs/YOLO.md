# Jupiter YOLO browser automation

## Finding (2026-10-26)

**Jupiter YOLO (`jup.ag/yolo`) has no documented public trading API or SDK.**

| Product | Long/Short | Public API | Notes |
|---------|------------|------------|--------|
| **YOLO** (Labs beta) | Yes (UI) | **No** | 500x–1,000x vs the House; JupUSD collateral; market orders only; **no native TP/SL**; earliest close **15s**; auto-close 72h; Jupiter co-signs opens/closes. |
| **Jupiter Perps** (JLP) | Yes | **Yes** | Separate product — not wired here. |
| **Jupiter Spot Swap** | Long-only | Yes | Cannot open a true short. |

## What this bot implements (Option B — approved)

Brittle **Playwright** driver against [jup.ag/yolo/?market=SOL&mode=classic](https://jup.ag/yolo/?market=SOL&mode=classic):

| Action | Dry-run (default) | Live (`DRY_RUN=false` **and** `YOLO_LIVE=true`) |
|--------|-------------------|--------------------------------------------------|
| Navigate | Load page + screenshot | Same |
| Open LONG / SHORT | Simulate + log + screenshot; **no click confirm / no sign** | Click Long/Short (wallet must already be connected in persistent profile) |
| Close | Simulate | Click Close after ≥15s lockout |
| TP / SL / max hold | Off-page poll of SOL mark; close when hit | Same + UI close |

### Defaults

- `DRY_RUN=true` — never signs
- Collateral **5** JupUSD (market minimum = tiny size)
- Leverage **500x** (lowest offered)
- Scan every **30s** → LONG / SHORT / DO NOTHING (solana-skill PA on SOL)
- TP **+50%** / SL **−20%** as **collateral PnL %** ≈ `priceMove% × leverage`
- Hard max hold **40s** (YOLO also allows close only after 15s)
- Private key is **never** injected into the browser

### Extreme risk

At 500x–1,000x, ~**0.1–0.2%** adverse price move **busts** the position (full collateral loss). A “−20% collateral SL” is only a **0.04%** adverse move at 500x — often unreachable before bust if the UI/poll lags. Treat YOLO automation as experimental.

## UI fragility (expect breakage)

See `src/yolo/selectors.ts`. Button labels, DOM, terms modals, and maintenance banners change without notice. Fill price is Pyth Pro ~2s after submit, not the on-screen quote. Captcha / wallet popups may need headed mode + a human.

## How to run (dry-run only until you go live)

```bash
npm install
npx playwright install chromium   # once
npm run build

# Short browser dry-run (screenshots under data/yolo-screenshots/)
npm run bot -- yolo dry-run --seconds 90
# or
npm run yolo:dry-run

# Status / positions
npm run bot -- yolo status

# Mark-proxy paper (no browser)
npm run paper
```

**Live clicks (not recommended; user must opt in):**

```bash
# 1) Create a persistent Chromium profile and connect wallet once (headed)
# 2) Then:
export DRY_RUN=false
export YOLO_LIVE=true
export YOLO_USER_DATA_DIR=/path/to/yolo-profile
export YOLO_HEADLESS=false
npm run bot -- yolo run --seconds 120
```

The driver **does not** load `.wallet/keypair.json` into the page. Wallet signing is only via an already-connected extension in `YOLO_USER_DATA_DIR`.

## Withdraw

Use the existing CLI (unchanged):

```bash
npm run bot -- wallet withdraw <DEST_PUBKEY> <AMOUNT_SOL>       # preview
npm run bot -- wallet withdraw <DEST_PUBKEY> <AMOUNT_SOL> --yes # confirm
```

## Related code

| Path | Role |
|------|------|
| `src/yolo/driver.ts` | Playwright + dry-run mock |
| `src/yolo/selectors.ts` | Fragile UI selectors |
| `src/yolo/scan-sol.ts` | SOL PA → LONG/SHORT/DO NOTHING |
| `src/yolo/monitor.ts` | Off-page TP/SL/40s |
| `src/yolo/loop.ts` | 30s scan loop |
| `scripts/paper-yolo.ts` | Mark-proxy paper session |
| `scripts/yolo-dry-run.ts` | Browser dry-run harness |
