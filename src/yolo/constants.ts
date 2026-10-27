/**
 * Shared YOLO / paper harness timing + size defaults.
 * Keep paper, browser loop, and engine monitor in lockstep.
 */
export const YOLO_SCAN_INTERVAL_MS = 30_000;
export const YOLO_MAX_HOLD_MS = 40_000;
export const YOLO_MAX_HOLD_SECONDS = 40;
export const YOLO_POSITION_POLL_MS = 5_000;
/** YOLO UI refuses Close until this many ms after open. */
export const YOLO_CLOSE_LOCKOUT_MS = 15_000;
export const YOLO_DEFAULT_COLLATERAL = 5;
export const YOLO_DEFAULT_LEVERAGE = 500;
export const YOLO_DEFAULT_TP_PCT = 50;
export const YOLO_DEFAULT_SL_PCT = 20;

export const YOLO_HARNESS = {
  scanIntervalMs: YOLO_SCAN_INTERVAL_MS,
  maxHoldMs: YOLO_MAX_HOLD_MS,
  maxHoldSeconds: YOLO_MAX_HOLD_SECONDS,
  positionPollMs: YOLO_POSITION_POLL_MS,
  closeLockoutMs: YOLO_CLOSE_LOCKOUT_MS,
  collateral: YOLO_DEFAULT_COLLATERAL,
  leverage: YOLO_DEFAULT_LEVERAGE,
  takeProfitPct: YOLO_DEFAULT_TP_PCT,
  stopLossPct: YOLO_DEFAULT_SL_PCT,
} as const;
