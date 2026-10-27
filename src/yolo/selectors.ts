/**
 * Fragile YOLO UI selectors for https://jup.ag/yolo/?market=SOL&mode=classic
 *
 * Jupiter Labs ships frequent UI changes. These are best-effort role/text
 * matchers — expect breakage. Prefer getByRole / getByText over CSS ids.
 *
 * Documented UI flow (docs.jup.ag YOLO trading, verified 2026-10-26):
 *  1. Connect wallet
 *  2. Accept terms → button "Accept and Continue"
 *  3. Pick market (SOL / BTC / ETH / ZEC / HYPE)
 *  4. Enter collateral under "You're paying" (min 5 JupUSD); 25% / Half / Max
 *  5. Set leverage 500–1000 (slider or − / +)
 *  6. Click **Long** or **Short** → wallet approve
 *  7. Close after ≥15s lockout:
 *       - "Close" on Positions row
 *       - "Close position" under chart
 *       - "Close all" above Positions (skips still-locked)
 *     During lockout the button may read "Close in 12s" etc.
 *
 * NO native TP/SL — bot must poll mark and click Close.
 *
 * Dry-run policy: navigate + optional terms dismiss + scroll-to Long/Short
 * for screenshots. NEVER click Long / Short / Close / Close position / Close all
 * while dryRun || !liveEnabled.
 *
 * Live DOM note: headless Chromium often gets a blank/captcha shell — use
 * `npm run bot -- yolo probe` and treat misses as fragile, not proof of absence.
 * Docs remain the source of truth for button copy.
 */
export const YOLO_URL_SOL_CLASSIC = "https://yolo.jup.ag/?market=SOL&mode=classic";
/** @deprecated alias — prefer yolo.jup.ag (WalletConnect metadata host) */
export const YOLO_URL_SOL_CLASSIC_LEGACY = "https://jup.ag/yolo/?market=SOL&mode=classic";

/** Role/text candidates tried in order. First match wins. */
export const SELECTORS = {
  connectWallet: [
    { role: "button" as const, name: /connect\s*wallet/i },
    { role: "button" as const, name: /connect/i },
  ],
  /** Wallet modal — prefer Phantom (injected provider identifies as Phantom). */
  /** Expand full wallet list when modal only shows Jupiter Wallet / Mobile */
  viewMoreWallets: [
    { role: "button" as const, name: /view\s*more\s*wallets/i },
    { text: /view\s*more\s*wallets/i },
  ],
  jupiterWallet: [
    { role: "button" as const, name: /jupiter\s*wallet/i },
    { text: /jupiter\s*wallet/i },
  ],
  continueToPhantom: [
    { role: "button" as const, name: /continue\s*to\s*phantom/i },
    { text: /continue\s*to\s*phantom/i },
  ],
  phantomWallet: [
    { role: "button" as const, name: /^phantom$/i },
    { text: /^phantom$/i },
    { role: "button" as const, name: /phantom/i },
  ],
  /** Seasonal / promo overlays that block the ticket */
  dismissOverlay: [
    { role: "button" as const, name: /maybe\s*later/i },
    { role: "button" as const, name: /^close$/i },
    { role: "button" as const, name: /^not\s*now$/i },
    { role: "button" as const, name: /^skip$/i },
  ],
  /** Docs: "Accept and Continue" */
  acceptTerms: [
    { role: "button" as const, name: /accept\s+and\s+continue/i },
    { role: "button" as const, name: /accept\s*(and\s*)?continue/i },
    { role: "button" as const, name: /^accept$/i },
  ],
  marketSol: [
    { role: "button" as const, name: /^SOL$/i },
    { role: "tab" as const, name: /^SOL$/i },
    { text: /^SOL$/ },
  ],
  /** Collateral amount input near "You're paying" */
  collateralInput: [
    'input[inputmode="decimal"]',
    'input[type="number"]',
    'input[placeholder*="0"]',
  ],
  percent25: [{ role: "button" as const, name: /^25%$/i }],
  half: [{ role: "button" as const, name: /^half$/i }],
  max: [{ role: "button" as const, name: /^max$/i }],
  /** Leverage − / + (YOLO 500–1000). Prefer − until ~500 when UI defaults to 1000. */
  leverageMinus: [
    { role: "button" as const, name: /^−$/ },
    { role: "button" as const, name: /^-$/ },
    { role: "button" as const, name: /decrease\s*leverage/i },
  ],
  leveragePlus: [
    { role: "button" as const, name: /^\+$/ },
    { role: "button" as const, name: /increase\s*leverage/i },
  ],
  /** Docs: click "Long" or "Short" — text/CSS fallbacks when a11y name misses */
  longButton: [
    { role: "button" as const, name: /^long$/i },
    { role: "button" as const, name: /\blong\b/i },
    { role: "button" as const, name: /go\s*long/i },
    { text: /^long$/i },
    'button:has-text("LONG")',
    'button:has-text("Long")',
    '[role="button"]:has-text("LONG")',
  ],
  shortButton: [
    { role: "button" as const, name: /^short$/i },
    { role: "button" as const, name: /\bshort\b/i },
    { role: "button" as const, name: /go\s*short/i },
    { text: /^short$/i },
    'button:has-text("SHORT")',
    'button:has-text("Short")',
    '[role="button"]:has-text("SHORT")',
  ],
  /**
   * Positions-row Close. During 15s lockout may be "Close in Ns" (disabled).
   * Prefer exact ^close$ before close-in countdown so we don't click early.
   */
  closePosition: [
    { role: "button" as const, name: /^close$/i },
    { role: "button" as const, name: /^close\s*position$/i },
    { role: "button" as const, name: /close\s*position/i },
    "button:has-text(\"Close\")",
    "[role=\"button\"]:has-text(\"Close\")",
  ],
  /** Under-chart close for the focused position */
  closePositionUnderChart: [
    { role: "button" as const, name: /^close\s*position$/i },
  ],
  /** Lockout countdown label — visible but must NOT be clicked until enabled */
  closeCountdown: [
    { role: "button" as const, name: /close\s*in\s*\d+\s*s/i },
  ],
  closeAll: [{ role: "button" as const, name: /close\s*all/i }],
  positionsTab: [
    { role: "tab" as const, name: /positions/i },
    { role: "button" as const, name: /positions/i },
  ],
} as const;

/** Keys that dry-run must never activate for trade intent. */
export const DRY_RUN_FORBIDDEN_CLICKS = [
  "longButton",
  "shortButton",
  "closePosition",
  "closePositionUnderChart",
  "closeAll",
] as const;

export const FRAGILITY_NOTES = [
  "No public YOLO trade API — browser only.",
  "Button labels / DOM change without notice.",
  "15s close lockout after open (Close in Ns).",
  "Fill is Pyth Pro ~2s after submit, not the on-screen quote.",
  "At 500–1000x, ~0.1–0.2% adverse move busts the position.",
  "LIVE uses injected Phantom provider (Node signs; secret never enters page JS) or a pre-connected extension profile.",
  "Terms modal / maintenance banners can block clicks.",
  "Captcha / wallet popup may require headed mode + human.",
  "Headless probes often see a blank shell — re-check headed before trusting selector misses.",
];
