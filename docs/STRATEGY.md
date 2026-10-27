# Strategy notes (solana-skill aligned)

Encoded in `config.json` / `.env` for this bot:

## Entries
- Prefer stacked bull tags; require **≥1 momentum tag** (`maru_bull` or `3soldiers`).
- `minPreferredTagCount=2`, `minPatternScore=68`.
- Soft-block bearish tags (`shoot_star`, `bear_engulf`, `maru_bear`, `3crows`, `hang_man`).
- Prefer graduated; min liquidity $1000; age ≥5m.
- Re-entry cooldown 10m after any close (bypass only with strong fresh volume — see config).
- Auto-denylist on SL, red cut, and after 2 losses; max 2 entries per mint.

## Exits (user-requested for this bot)
- **Take-profit +50%**
- **Stop-loss −20%** (flash dumps can gap past the stop)
- Max hold 15m (optional time-exit)
- Early red cut at 3m if PnL ≤ 0%

Note: live skill cohort data often preferred fee-aware TP ~+15–20% inside a shorter hold. This bot intentionally uses the user-approved **+50 / −20** profile; expect more time/early exits than TPs until PA is exceptionally strong.

## Execution
- Jupiter Swap API v2 only (order → sign → execute when `DRY_RUN=false`).
- Not the jup.ag/yolo leveraged UI.
