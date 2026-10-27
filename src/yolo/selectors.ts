/**
 * Fragile YOLO UI selectors for https://jup.ag/yolo/?market=SOL&mode=classic
 *
 * Jupiter Labs ships frequent UI changes. These are best-effort role/text
 * matchers — expect breakage. Prefer getByRole / getByText over CSS ids.
 *
 * Documented UI flow (2026-10-26 docs.jup.ag):
 *  1. Connect wallet
 *  2. Accept terms (first visit)
 *  3. Pick market (SOL/BTC/ETH/ZEC/HYPE)
 *  4. Enter collateral under "You're paying" (min 5 JupUSD)
 *  5. Set leverage 500–1000
 *  6. Click Long or Short → wallet approve
 *  7. Close after ≥15s lockout via Positions row Close / Close position
 *
 * NO native TP/SL — bot must poll mark and click Close.
 */

export const YOLO_URL_SOL_CLASSIC = "https://jup.ag/yolo/?market=SOL&mode=classic";

/** Role/text candidates tried in order. First match wins. */
export const SELECTORS = {
  connectWallet: [
    { role: "button" as const, name: /connect\s*wallet/i },
    { role: "button" as const, name: /connect/i },
  ],
  acceptTerms: [
    { role: "button" as const, name: /accept\s*(and\s*)?continue/i },
    { role: "button" as const, name: /accept/i },
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
  longButton: [
    { role: "button" as const, name: /^long$/i },
    { role: "button" as const, name: /go\s*long/i },
  ],
  shortButton: [
    { role: "button" as const, name: /^short$/i },
    { role: "button" as const, name: /go\s*short/i },
  ],
  closePosition: [
    { role: "button" as const, name: /^close$/i },
    { role: "button" as const, name: /close\s*position/i },
  ],
  closeAll: [{ role: "button" as const, name: /close\s*all/i }],
  positionsTab: [
    { role: "tab" as const, name: /positions/i },
    { role: "button" as const, name: /positions/i },
  ],
} as const;

export const FRAGILITY_NOTES = [
  "No public YOLO trade API — browser only.",
  "Button labels / DOM change without notice.",
  "15s close lockout after open (Close in Ns).",
  "Fill is Pyth Pro ~2s after submit, not the on-screen quote.",
  "At 500–1000x, ~0.1–0.2% adverse move busts the position.",
  "Wallet must be pre-connected for LIVE; driver never injects private keys.",
  "Terms modal / maintenance banners can block clicks.",
  "Captcha / wallet popup may require headed mode + human.",
];
