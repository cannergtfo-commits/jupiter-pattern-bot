/** YOLO browser automation types. UI is brittle — selectors can break without notice. */

export type YoloSide = "LONG" | "SHORT";
export type YoloCloseReason = "tp" | "sl" | "time" | "manual" | "bust" | "simulated";
export type YoloMarket = "SOL" | "BTC" | "ETH" | "ZEC" | "HYPE";

export interface YoloDriverConfig {
  /** Default true — never click confirm / never sign. */
  dryRun: boolean;
  /** Headless Chromium. Screenshots still work. */
  headless: boolean;
  market: YoloMarket;
  mode: "classic";
  /** Collateral in paying token / JupUSD. YOLO min is 5 JupUSD. */
  collateral: number;
  /** 500–1000 in steps of 100. Prefer lowest for room before bust. */
  leverage: number;
  /** YOLO page URL */
  url: string;
  /** Optional persistent Playwright profile (for LIVE wallet connect). */
  userDataDir?: string;
  /** Directory for dry-run / debug screenshots. */
  screenshotDir: string;
  /** Navigation / action timeouts (ms). */
  timeoutMs: number;
  /**
   * LIVE only: if true, actually click Long/Short and attempt close.
   * Requires DRY_RUN=false AND YOLO_LIVE=true. Wallet must already be
   * connected in the persistent profile — this driver does NOT inject keys.
   */
  liveEnabled: boolean;
}

export interface YoloOpenRequest {
  side: YoloSide;
  market?: YoloMarket;
  collateral?: number;
  leverage?: number;
  /** Entry mark used for off-page TP/SL (spot SOL proxy OK). */
  entryMarkUsd: number;
  note?: string;
}

export interface YoloActionResult {
  ok: boolean;
  dryRun: boolean;
  action: "open" | "close" | "navigate" | "screenshot" | "noop";
  side?: YoloSide;
  message: string;
  screenshotPath?: string;
  /** Simulated or recorded position id */
  positionId?: string;
  error?: string;
}

export interface YoloPosition {
  id: string;
  side: YoloSide;
  market: YoloMarket;
  entryMarkUsd: number;
  collateral: number;
  leverage: number;
  openedAt: string;
  status: "open" | "closed";
  dryRun: boolean;
  closeReason?: YoloCloseReason;
  closedAt?: string;
  exitMarkUsd?: number;
  /** Collateral PnL % ≈ priceMove% * leverage * sideSign */
  collateralPnlPct?: number;
  note?: string;
}

export interface YoloScanRec {
  action: "LONG" | "SHORT" | "DO NOTHING";
  market: YoloMarket;
  markUsd: number;
  reason: string;
  tags: string[];
  score: number;
  bias: "bullish" | "bearish" | "neutral";
}
