# Jupiter YOLO vs this bot — API reality check

## Finding (2026-10-26)

**Jupiter YOLO (`jup.ag/yolo`) has no documented public trading API or SDK.**

| Product | Long/Short | Public API | Notes |
|---------|------------|------------|--------|
| **YOLO** (Labs beta) | Yes (UI) | **No** | 500x–1,000x vs the House; JupUSD collateral; market orders only; **no native TP/SL**; earliest close **15s**; auto-close 72h; Jupiter co-signs opens/closes. Docs: [YOLO overview](https://docs.jup.ag/user-docs/labs/yolo), [trading](https://docs.jup.ag/user-docs/labs/yolo/trading). Probed `api.jup.ag/yolo` / `yolo-api.jup.ag` → 404. |
| **Jupiter Perps** (JLP) | Yes | **Yes** | Separate product. [Perps API](https://perps-api.jup.ag/v1/docs) + community SDK [`jupiter-perps-api-sdk`](https://github.com/julianfssen/jupiter-perps-api-sdk) (`increasePosition` with `side: "long" \| "short"`). Not YOLO leverage/rules. |
| **Jupiter Spot Swap** | Long-only | Yes | `api.jup.ag/swap/v2` — buy token / sell to SOL. Cannot open a true short. |

## What this bot does today

1. **Scan every 30s** and print a clear recommendation: **LONG / SHORT / DO NOTHING**.
2. **Spot path (DRY_RUN default):** may open a spot long only when recommendation is LONG. SHORT is **signal-only** (skip entry / prefer close open long) — we do **not** pretend a spot swap is a YOLO short.
3. **Max hold 40s** hard cap on monitored positions; TP +50% / SL −20% if hit earlier; position poll ~5s.
4. Secure local wallet (0600 / optional AES-GCM keystore) + `wallet withdraw <dest> <sol> --yes`.

## YOLO leverage warning

At 500x–1,000x, ~**0.1–0.2%** adverse price move can **bust** the position (full collateral loss). YOLO has **no stop loss / take profit** in-product. A bot “−20% SL / +50% TP” would require polling and manual close after the 15s lockout — extremely fragile at that leverage. Profits may enter a **House payout queue**.

## Paths forward (needs user choice)

| Option | Meaning |
|--------|---------|
| **A — Signal-only YOLO** (current) | Bot prints LONG/SHORT; you click on [jup.ag/yolo](https://jup.ag/yolo/?market=SOL&mode=classic). Safest automation boundary. |
| **B — Browser automation** | Drive the YOLO UI with a signed-in wallet. Brittle, high-risk, needs **explicit user approval**. Not implemented. |
| **C — Jupiter Perps API** | Real programmatic long/short via `perps-api.jup.ag` (not YOLO). Different risk/leverage. Can be wired if you choose Perps over YOLO. |

**Ask before enabling B or C.** Default remains DRY_RUN + signals.
