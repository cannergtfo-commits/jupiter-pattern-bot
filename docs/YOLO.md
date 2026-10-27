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
- Private key **never** enters page JS / screenshots; Node signs via injected Phantom provider (`YOLO_INJECT_WALLET`)

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

# Mark-proxy paper (no browser) — see docs/PAPER.md
npm run paper                         # 5 min
npm run paper -- --minutes 10
npm run paper -- --minutes 15 --force-min 4
```

**Connect + live (user must opt in for live):**

```bash
# 1) Prove Connect (dry-run safe):
npm run yolo:connect

# 2) One live trade at min 5 JupUSD (script sets LIVE then reverts):
npm run yolo:one-live

# 3) Or timed live loop:
export DRY_RUN=false
export YOLO_LIVE=true
export YOLO_INJECT_WALLET=true
export YOLO_HEADLESS=false
export YOLO_COLLATERAL=5
npm run bot -- yolo run --seconds 120
```

Preferred: injected Phantom provider (`YOLO_INJECT_WALLET=true`) — Node loads `.wallet` and signs via `exposeFunction`; only the public key enters page JS. Fallback: already-connected extension in `YOLO_USER_DATA_DIR` (never paste bot secret into chat).

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
| `src/yolo/paper-engine.ts` | Reusable paper harness (30s scan / 40s hold / TP50 / SL20) |
| `scripts/paper-yolo.ts` | Mark-proxy paper CLI (`--minutes`, skill scans) |
| `scripts/yolo-dry-run.ts` | Browser dry-run harness |

## Long / Short selectors (dry-run safe)

Source of truth: `src/yolo/selectors.ts` (aligned with [YOLO trading docs](https://docs.jup.ag/user-docs/labs/yolo/trading) as of 2026-10-26).

| Action | Selector keys | Docs copy | Dry-run |
|--------|---------------|-----------|---------|
| Terms | `acceptTerms` | Accept and Continue | May click (dismiss only) |
| Market | `marketSol` | SOL | May click |
| Collateral | `collateralInput`, `percent25`, `half`, `max` | You're paying / 25% / Half / Max | May fill (no submit) |
| Open long | `longButton` | **Long** | Locate + screenshot — **no click** |
| Open short | `shortButton` | **Short** | Locate + screenshot — **no click** |
| Close | `closePosition`, `closePositionUnderChart` | Close / Close position | **no click** |
| Lockout | `closeCountdown` | Close in Ns | Observe only |
| Close all | `closeAll` | Close all | **no click** |

Forbidden trade clicks while dry: `DRY_RUN_FORBIDDEN_CLICKS` in selectors.ts.

```bash
npm run bot -- yolo probe          # headless probe, never clicks Long/Short/Close
npm run bot -- yolo probe --headed # human-visible
npm run yolo:dry-run               # 90s simulated loop
```

Headless Chromium often gets a blank/captcha shell on jup.ag — a MISS is **not** proof the selector is wrong. Prefer docs + headed re-check.

## Paper harness timing

Shared constants in `src/yolo/constants.ts` / `YOLO_HARNESS`:

| Knob | Value |
|------|--------|
| Decision cycle | **30s** → LONG / SHORT / DO NOTHING |
| Max hold | **40s** hard |
| Position poll | **5s** |
| Close lockout (UI) | **15s** |
| TP / SL | **+50%** / **−20%** collateral PnL |

```bash
npm run paper                      # mark-proxy, no browser
npm run bot -- yolo paper --minutes 5
npm run test:paper                 # unit tests for exit/timing
```

## Learning from paper / YOLO closes

1. Each TP/SL/time close → `recordClosedTradeLesson` → `data/trade-learnings.json` + append `data/pending-skill-lessons.jsonl`
2. Merge reusable bullets into docs:

```bash
npm run lessons:merge -- --dry     # preview
npm run lessons:merge              # append docs/trade-learnings.md, archive pending
# or: npm run bot -- lessons merge
```

Same spirit as the memecoin bot: close → lesson → pending JSONL → human/agent merges into skill notes.

## Lessons from 2026-10-26 one-live attempt (box)

- Headless Chromium often returns a **black** page (0 selectors). Prefer `YOLO_HEADLESS=false`.
- Seasonal **YOLO after dark** modal can cover the ticket — dismiss via "Maybe later" / Enable / X (`SELECTORS.dismissOverlay`).
- Until a wallet is connected in `YOLO_USER_DATA_DIR`, the primary CTA is **Connect**, not Long/Short → error `wallet_not_connected`.
- Prefer `npm run yolo:connect` (injected Phantom; secret stays in Node). Extension profile is fallback only — never paste bot secret into chat.
- UI may default leverage to **1000x**; bust ≈ **0.1%** adverse. Requested size remains min **5 JupUSD**.
- One-shot harness: `npm run yolo:one-live` (reverts `DRY_RUN=true` / `YOLO_LIVE=false` on exit).

## Box-run Connect flow (injected Phantom — preferred)

The bot wallet lives in `.wallet/` on the box (gitignored). **Never paste the private key into chat, Phantom UI, screenshots, or git.**

Instead, Playwright injects a **Phantom-compatible** `window.solana` / `window.phantom.solana` provider:

1. Node loads the keypair via `loadKeypair()` (secret stays in process memory).
2. Only the **public** base58 address is passed into `addInitScript`.
3. `signTransaction` / `signMessage` call `page.exposeFunction` → Node signs → returns base64 only.
4. Driver clicks **Connect** → **Phantom** in the Jupiter modal.

```bash
# Prove Connect (stays DRY_RUN — no Long/Short click)
npm run yolo:connect
# or headless:
npm run bot -- yolo connect

# Public fund address (only):
# 4617n4ihWMAvypgZMTb73Eptgxh4FK1Z9m5649XnpvLP
# Need ≥5 JupUSD collateral + SOL for gas.
```

Env (all optional — defaults shown):

| Var | Default | Meaning |
|-----|---------|---------|
| `YOLO_INJECT_WALLET` | `true` | Inject Phantom-compatible provider |
| `YOLO_AUTO_APPROVE` | `true` | Node auto-approves signatures (no popup) |
| `YOLO_HEADLESS` | `true` (`false` for connect/one-live scripts) | Prefer headed — headless often blank/captcha |
| `YOLO_COLLATERAL` | `5` | **Always min 5 JupUSD** (clamped) |
| `YOLO_LEVERAGE` | `500` | Prefer lowest |

**MetaMask / EVM:** not used — YOLO is Solana. Do not import this key into MetaMask.

**Real Phantom extension import:** avoided on purpose (would require pasting the secret into a UI). Use inject path.

### One live trade after Connect works

```bash
# Still opt-in; reverts DRY_RUN on exit. Size forced to ≥5 JupUSD.
npm run yolo:one-live
```

Requires: Connect OK, funded public address (≥5 JupUSD + SOL gas), `DRY_RUN=false` + `YOLO_LIVE=true` set by the script only for that run.


## Connect proof (box, 2026-10-26 PDT)

Headed `npm run yolo:connect` against funded public `4617n4ih…npvLP`:
- Injected Phantom + Wallet Standard registered (secret stays in Node).
- UI showed truncated `46…LP` and **LONG / SHORT** (no Connect CTA).
- UI still defaults collateral ~10 JupUSD / **1000x** — live open path clamps collateral to **≥5** and nudges leverage toward **500x** via − clicks.
- Stay `DRY_RUN` until BLAZAR runs `yolo:one-live`.

### Fallback: extension profile (human)

If inject Connect fails (captcha / wallet modal change):

1. `YOLO_USER_DATA_DIR=./data/yolo-profile YOLO_HEADLESS=false YOLO_INJECT_WALLET=false`
2. Hand the box to a human to Connect **their own** wallet in headed Chromium — **do not** ask them to paste the bot private key.
3. Or fund a wallet they control and point live at that profile instead.

