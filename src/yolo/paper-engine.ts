/**
 * Mark-proxy paper harness (no browser, no signing).
 * Enforces: 30s LONG/SHORT/DO NOTHING decision cycle + 40s hard max hold.
 * Records a lesson on every paper close (same path as live YOLO monitor).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT } from "../config.js";
import { recordClosedTradeLesson } from "../learning.js";
import {
  YOLO_DEFAULT_COLLATERAL,
  YOLO_DEFAULT_LEVERAGE,
  YOLO_DEFAULT_SL_PCT,
  YOLO_DEFAULT_TP_PCT,
  YOLO_MAX_HOLD_MS,
  YOLO_POSITION_POLL_MS,
  YOLO_SCAN_INTERVAL_MS,
} from "./constants.js";
import { collateralPnlPct, fetchSolMarkUsd } from "./mark.js";

export type PaperSide = "LONG" | "SHORT";
export type PaperCloseReason = "tp" | "sl" | "time";
export type PaperSignal = PaperSide | "DO NOTHING";

export interface PaperPos {
  id: string;
  side: PaperSide;
  entry: number;
  openedAt: number;
  leverage: number;
  collateral: number;
  note?: string;
}

export interface ClosedPaperTrade {
  id: string;
  side: PaperSide;
  entry: number;
  exit: number;
  reason: PaperCloseReason;
  holdSec: number;
  priceMovePct: number;
  collateralPnlPct: number;
  pnlUsd: number;
  openedAt: string;
  closedAt: string;
  lessonId?: string;
}

export interface PaperHarnessOpts {
  durationMs?: number;
  scanMs?: number;
  pollMs?: number;
  maxHoldMs?: number;
  tpPct?: number;
  slPct?: number;
  leverage?: number;
  collateral?: number;
  /** Force a few entries if signal-starved (paper only). */
  forceMinTrades?: number;
  /** Persist session JSON under data/. */
  outPath?: string;
  /** Record lessons via learning.ts (default true). */
  recordLessons?: boolean;
  /** Inject marks for unit tests (skips network). */
  markFetcher?: () => Promise<number>;
  /** Inject clock for deterministic tests. */
  now?: () => number;
  /** Inject sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  log?: (row: Record<string, unknown>) => void;
  /**
   * Optional async signal source (e.g. scanSolForYolo).
   * When omitted, uses decidePaperSignal(marks) momentum.
   */
  signalFetcher?: () => Promise<{
    signal: PaperSignal;
    note?: string;
    meta?: Record<string, unknown>;
  }>;
  /** Optional session id stamped into logs / notes. */
  sessionId?: string;
}

export interface PaperHarnessResult {
  trades: number;
  wins: number;
  losses: number;
  forcedSignals: number;
  netPnlUsd: number;
  netCollateralPnlPct: number;
  leverage: number;
  collateralPerTrade: number;
  tpPct: number;
  slPct: number;
  maxHoldSec: number;
  scanSec: number;
  pollSec: number;
  durationSec: number;
  firstMark?: number;
  lastMark?: number;
  closed: ClosedPaperTrade[];
  outPath?: string;
  sessionId?: string;
  signalSource?: string;
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Tiny momentum signal on recent marks — LONG / SHORT / DO NOTHING. */
export function decidePaperSignal(history: number[]): PaperSignal {
  if (history.length < 3) return "DO NOTHING";
  const a = history[history.length - 3]!;
  const b = history[history.length - 2]!;
  const c = history[history.length - 1]!;
  const m1 = ((b - a) / a) * 100;
  const m2 = ((c - b) / b) * 100;
  if (m1 > 0.01 && m2 > 0.005) return "LONG";
  if (m1 < -0.01 && m2 < -0.005) return "SHORT";
  if (m2 > 0.008) return "LONG";
  if (m2 < -0.008) return "SHORT";
  return "DO NOTHING";
}

/**
 * Pure exit decision used by the paper monitor and unit tests.
 * TP/SL are collateral PnL % (priceMove% × leverage).
 */
export function decidePaperExit(args: {
  side: PaperSide;
  entry: number;
  mark: number;
  leverage: number;
  holdMs: number;
  maxHoldMs: number;
  tpPct: number;
  slPct: number;
}): PaperCloseReason | null {
  const pnl = collateralPnlPct(args.side, args.entry, args.mark, args.leverage);
  if (pnl >= args.tpPct) return "tp";
  if (pnl <= -args.slPct) return "sl";
  if (args.holdMs >= args.maxHoldMs) return "time";
  return null;
}

function closePos(
  pos: PaperPos,
  mark: number,
  reason: PaperCloseReason,
  nowMs: number
): ClosedPaperTrade {
  const pnlPct = collateralPnlPct(pos.side, pos.entry, mark, pos.leverage);
  const priceMovePct = ((mark - pos.entry) / pos.entry) * 100;
  const holdSec = (nowMs - pos.openedAt) / 1000;
  return {
    id: pos.id,
    side: pos.side,
    entry: pos.entry,
    exit: mark,
    reason,
    holdSec: Number(holdSec.toFixed(1)),
    priceMovePct: Number(priceMovePct.toFixed(4)),
    collateralPnlPct: Number(pnlPct.toFixed(2)),
    pnlUsd: Number(((pnlPct / 100) * pos.collateral).toFixed(4)),
    openedAt: new Date(pos.openedAt).toISOString(),
    closedAt: new Date(nowMs).toISOString(),
  };
}

function recordLesson(
  trade: ClosedPaperTrade,
  pos: PaperPos,
  takeProfitPct: number,
  stopLossPct: number
): string | undefined {
  try {
    const lesson = recordClosedTradeLesson({
      position: {
        id: trade.id,
        mint: "YOLO-SOL-PAPER",
        symbol: `PAPER-${trade.side}-SOL`,
        entryPriceUsd: trade.entry,
        amountToken: 0,
        amountSolSpent: 0,
        takeProfitPct,
        stopLossPct,
        openedAt: trade.openedAt,
        status: "closed",
        closeReason: trade.reason,
        closedAt: trade.closedAt,
        exitPriceUsd: trade.exit,
        dryRun: true,
        entryMeta: {
          patternTags: [trade.side.toLowerCase(), "paper"],
          filterNotes: [
            `paper-yolo lev=${pos.leverage} coll=${pos.collateral} collPnl=${trade.collateralPnlPct}%`,
            pos.note ?? "",
          ].filter(Boolean),
        },
      },
      reason: trade.reason,
      exitPriceUsd: trade.exit,
      closedAt: trade.closedAt,
    });
    return lesson?.id;
  } catch (e) {
    console.log(`[paper] learning record failed: ${(e as Error).message}`);
    return undefined;
  }
}

export async function runPaperHarness(opts: PaperHarnessOpts = {}): Promise<PaperHarnessResult> {
  const durationMs = opts.durationMs ?? 5 * 60_000;
  const scanMs = opts.scanMs ?? YOLO_SCAN_INTERVAL_MS;
  const pollMs = opts.pollMs ?? YOLO_POSITION_POLL_MS;
  const maxHoldMs = opts.maxHoldMs ?? YOLO_MAX_HOLD_MS;
  const tpPct = opts.tpPct ?? YOLO_DEFAULT_TP_PCT;
  const slPct = opts.slPct ?? YOLO_DEFAULT_SL_PCT;
  const leverage = opts.leverage ?? YOLO_DEFAULT_LEVERAGE;
  const collateral = opts.collateral ?? YOLO_DEFAULT_COLLATERAL;
  const forceMin = opts.forceMinTrades ?? 3;
  const recordLessons = opts.recordLessons !== false;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? sleepDefault;
  const fetchMark = opts.markFetcher ?? fetchSolMarkUsd;
  const log = opts.log ?? ((row) => console.log(JSON.stringify(row)));
  const outPath =
    opts.outPath ?? path.join(ROOT, "data", "paper-yolo-session.json");

  const started = now();
  const endsAt = started + durationMs;

  log({
    event: "paper_start",
    dryRun: true,
    durationSec: durationMs / 1000,
    scanSec: scanMs / 1000,
    pollSec: pollMs / 1000,
    maxHoldSec: maxHoldMs / 1000,
    tp: tpPct,
    sl: slPct,
    leverage,
    collateral,
    forceMinTrades: forceMin,
    sessionId: opts.sessionId,
    signalSource: opts.signalFetcher ? "signalFetcher" : "momentum",
    note: "TP/SL = collateral PnL % at leverage. Spot SOL mark proxy. No wallet.",
  });

  const marks: number[] = [];
  const closed: ClosedPaperTrade[] = [];
  let open: PaperPos | null = null;
  let lastScan = 0;
  let forced = 0;

  const seed = await fetchMark();
  marks.push(seed);
  log({ event: "mark", price: seed, t: new Date(now()).toISOString() });

  while (now() < endsAt) {
    const mark = await fetchMark().catch((e) => {
      log({ event: "mark_error", err: String(e) });
      return marks[marks.length - 1]!;
    });
    marks.push(mark);
    if (marks.length > 40) marks.shift();

    if (open) {
      const hold = now() - open.openedAt;
      const reason = decidePaperExit({
        side: open.side,
        entry: open.entry,
        mark,
        leverage: open.leverage,
        holdMs: hold,
        maxHoldMs,
        tpPct,
        slPct,
      });
      if (reason) {
        const t = closePos(open, mark, reason, now());
        if (recordLessons) t.lessonId = recordLesson(t, open, tpPct, slPct);
        closed.push(t);
        log({ event: "close", ...t });
        open = null;
      } else {
        const pnl = collateralPnlPct(open.side, open.entry, mark, open.leverage);
        log({
          event: "hold",
          id: open.id,
          side: open.side,
          mark,
          collPnlPct: Number(pnl.toFixed(2)),
          holdSec: Number((hold / 1000).toFixed(1)),
          maxHoldSec: maxHoldMs / 1000,
        });
      }
    }

    const tnow = now();
    if (!open && tnow - lastScan >= scanMs) {
      lastScan = tnow;
      let signal: PaperSignal = "DO NOTHING";
      let note = "momentum";
      let meta: Record<string, unknown> | undefined;
      if (opts.signalFetcher) {
        try {
          const rec = await opts.signalFetcher();
          signal = rec.signal;
          note = rec.note ?? "skill-scan";
          meta = rec.meta;
        } catch (e) {
          log({ event: "scan_error", err: String(e) });
          signal = "DO NOTHING";
          note = `signalFetcher failed: ${String(e)}`;
        }
      } else {
        signal = decidePaperSignal(marks);
        note = "momentum";
      }
      const remaining = endsAt - tnow;
      const needForce =
        closed.length + (open ? 1 : 0) < forceMin && remaining > maxHoldMs + 5_000;
      if (signal === "DO NOTHING" && needForce) {
        const last = marks[marks.length - 1]!;
        const prev = marks[marks.length - 2] ?? last;
        signal = last >= prev ? "LONG" : "SHORT";
        forced += 1;
        note = `forced (${note})`;
        log({
          event: "force_signal",
          signal,
          reason: "signal-starved; forcing paper trade",
          forced,
          underlying: note,
        });
      } else {
        log({ event: "scan", signal, mark, marks: marks.slice(-3), note, meta });
      }

      if (signal === "LONG" || signal === "SHORT") {
        open = {
          id: randomUUID(),
          side: signal,
          entry: (typeof meta?.markUsd === "number" ? (meta.markUsd as number) : mark),
          openedAt: now(),
          leverage,
          collateral,
          note: `paper signal=${signal} | ${note}`,
        };
        log({
          event: "open",
          id: open.id,
          side: open.side,
          entry: open.entry,
          leverage,
          collateral,
          maxHoldSec: maxHoldMs / 1000,
          note: open.note,
        });
      }
    }

    const left = endsAt - now();
    if (left <= 0) break;
    await sleep(Math.min(pollMs, left));
  }

  if (open) {
    const mark = marks[marks.length - 1]!;
    const t = closePos(open, mark, "time", now());
    if (recordLessons) t.lessonId = recordLesson(t, open, tpPct, slPct);
    closed.push(t);
    log({ event: "close_session_end", ...t });
    open = null;
  }

  const netPnlUsd = closed.reduce((s, t) => s + t.pnlUsd, 0);
  const netCollPct = closed.reduce((s, t) => s + t.collateralPnlPct, 0);
  const wins = closed.filter((t) => t.collateralPnlPct > 0).length;
  const summary: PaperHarnessResult = {
    trades: closed.length,
    wins,
    losses: closed.length - wins,
    forcedSignals: forced,
    netPnlUsd: Number(netPnlUsd.toFixed(4)),
    netCollateralPnlPct: Number(netCollPct.toFixed(2)),
    leverage,
    collateralPerTrade: collateral,
    tpPct,
    slPct,
    maxHoldSec: maxHoldMs / 1000,
    scanSec: scanMs / 1000,
    pollSec: pollMs / 1000,
    durationSec: Math.round((now() - started) / 1000),
    firstMark: marks[0],
    lastMark: marks[marks.length - 1],
    closed,
    outPath,
    sessionId: opts.sessionId,
    signalSource: opts.signalFetcher ? "signalFetcher" : "momentum",
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify({ event: "paper_summary", dryRun: true, ...summary }, null, 2) + "\n",
    "utf8"
  );
  log({ event: "paper_summary", ...summary });
  log({ event: "wrote", path: outPath });
  return summary;
}
