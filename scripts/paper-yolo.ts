/**
 * Mark-proxy YOLO paper session (no browser, no wallet, no signing).
 *
 * - Scan every 30s → LONG / SHORT / DO NOTHING (solana-skill via scanSolForYolo)
 * - Paper open long+short with leverage collateral PnL
 * - TP +50% / SL −20% (collateral %) + hard close at 40s
 * - Writes results JSON + appends learnings jsonl
 *
 * DRY_RUN by nature — never touches .wallet or live YOLO.
 *
 * Usage:
 *   npm run paper
 *   npm run paper -- --minutes 10
 *   npm run paper -- --minutes 15 --force-min 4
 *   PAPER_DURATION_MS=600000 npm run paper
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collateralPnlPct, fetchSolMarkUsd } from "../src/yolo/mark.js";
import { scanSolForYolo } from "../src/yolo/scan-sol.js";
import type { YoloScanRec, YoloSide } from "../src/yolo/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const RESULTS_LATEST = path.join(DATA, "paper-yolo-session.json");
const LEARNINGS_JSONL = path.join(DATA, "paper-learnings.jsonl");

type CloseReason = "tp" | "sl" | "time";

interface PaperPos {
  id: number;
  side: YoloSide;
  entry: number;
  openedAt: number;
  leverage: number;
  collateral: number;
  signal: YoloScanRec;
  forced: boolean;
}

interface ClosedTrade {
  id: number;
  side: YoloSide;
  entry: number;
  exit: number;
  reason: CloseReason;
  holdSec: number;
  priceMovePct: number;
  collateralPnlPct: number;
  pnlUsd: number;
  openedAt: string;
  closedAt: string;
  forced: boolean;
  signalReason: string;
  tags: string[];
  score: number;
  bias: string;
  lesson: string;
}

function parseArgs(argv: string[]): {
  minutes: number;
  scanSec: number;
  pollSec: number;
  maxHoldSec: number;
  tp: number;
  sl: number;
  leverage: number;
  collateral: number;
  forceMin: number;
} {
  const get = (flag: string, env: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const e = process.env[env];
    if (e && Number.isFinite(Number(e))) return Number(e);
    return fallback;
  };

  // Duration: --minutes wins; else PAPER_DURATION_MS; else 5 min
  let minutes = get("--minutes", "PAPER_MINUTES", 5);
  if (process.env.PAPER_DURATION_MS && !argv.includes("--minutes")) {
    minutes = Number(process.env.PAPER_DURATION_MS) / 60_000;
  }

  return {
    minutes: Math.max(1, Math.min(60, minutes)),
    scanSec: get("--scan-sec", "PAPER_SCAN_MS", 30) > 100
      ? get("--scan-sec", "PAPER_SCAN_MS", 30_000) / 1000
      : get("--scan-sec", "PAPER_SCAN_SEC", 30),
    pollSec: (() => {
      const raw = get("--poll-sec", "PAPER_POLL_MS", 5);
      return raw > 100 ? raw / 1000 : get("--poll-sec", "PAPER_POLL_SEC", 5);
    })(),
    maxHoldSec: (() => {
      const raw = get("--max-hold-sec", "PAPER_MAX_HOLD_MS", 40);
      return raw > 200 ? raw / 1000 : get("--max-hold-sec", "PAPER_MAX_HOLD_SEC", 40);
    })(),
    tp: get("--tp", "PAPER_TP_PCT", 50),
    sl: get("--sl", "PAPER_SL_PCT", 20),
    leverage: get("--leverage", "PAPER_LEVERAGE", 500),
    collateral: get("--collateral", "PAPER_COLLATERAL", 5),
    forceMin: get("--force-min", "PAPER_FORCE_MIN", 2),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildLesson(t: ClosedTrade): string {
  const tags = t.tags.length ? t.tags.join(",") : "none";
  if (t.reason === "tp") {
    return `WIN TP: ${t.side} score=${t.score} tags=[${tags}] collPnl=${t.collateralPnlPct}% — reinforce similar PA.`;
  }
  if (t.reason === "sl") {
    return `LOSS SL: ${t.side} score=${t.score} tags=[${tags}] collPnl=${t.collateralPnlPct}% — fade or require stronger confluence.`;
  }
  const tone =
    t.collateralPnlPct > 0 ? "green time-exit" : t.collateralPnlPct < 0 ? "red time-exit" : "flat time-exit";
  return `${tone.toUpperCase()}: ${t.side} held ${t.holdSec}s score=${t.score} tags=[${tags}] — 40s cap dominated; tighten entry or accept chop.`;
}

function closePos(pos: PaperPos, mark: number, reason: CloseReason): ClosedTrade {
  const pnlPct = collateralPnlPct(pos.side, pos.entry, mark, pos.leverage);
  const priceMovePct = ((mark - pos.entry) / pos.entry) * 100;
  const holdSec = (Date.now() - pos.openedAt) / 1000;
  const base: ClosedTrade = {
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
    closedAt: new Date().toISOString(),
    forced: pos.forced,
    signalReason: pos.signal.reason,
    tags: pos.signal.tags,
    score: pos.signal.score,
    bias: pos.signal.bias,
    lesson: "",
  };
  base.lesson = buildLesson(base);
  return base;
}

function appendLearning(trade: ClosedTrade, sessionId: string): void {
  fs.mkdirSync(DATA, { recursive: true });
  const row = {
    at: trade.closedAt,
    sessionId,
    venue: "yolo-paper-mark-proxy",
    dryRun: true,
    outcome: trade.collateralPnlPct > 0 ? "win" : trade.collateralPnlPct < 0 ? "loss" : "flat",
    reason: trade.reason,
    side: trade.side,
    entry: trade.entry,
    exit: trade.exit,
    collateralPnlPct: trade.collateralPnlPct,
    pnlUsd: trade.pnlUsd,
    holdSec: trade.holdSec,
    leverage: undefined as number | undefined,
    tags: trade.tags,
    score: trade.score,
    bias: trade.bias,
    forced: trade.forced,
    lesson: trade.lesson,
    signalReason: trade.signalReason,
  };
  fs.appendFileSync(LEARNINGS_JSONL, JSON.stringify(row) + "\n", "utf8");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const DURATION_MS = opts.minutes * 60_000;
  const SCAN_MS = opts.scanSec * 1000;
  const POLL_MS = opts.pollSec * 1000;
  const MAX_HOLD_MS = opts.maxHoldSec * 1000;
  const { tp: TP_PCT, sl: SL_PCT, leverage: LEVERAGE, collateral: COLLATERAL, forceMin: FORCE_MIN } =
    opts;

  const sessionId = `paper-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const started = Date.now();
  const endsAt = started + DURATION_MS;

  console.log(
    JSON.stringify({
      event: "paper_start",
      sessionId,
      durationSec: DURATION_MS / 1000,
      scanSec: SCAN_MS / 1000,
      pollSec: POLL_MS / 1000,
      maxHoldSec: MAX_HOLD_MS / 1000,
      tp: TP_PCT,
      sl: SL_PCT,
      leverage: LEVERAGE,
      collateral: COLLATERAL,
      forceMinTrades: FORCE_MIN,
      signalSource: "scanSolForYolo (solana-skill candles/volume)",
      note: "TP/SL = collateral PnL % at leverage (price×lev). Spot SOL mark proxy. No wallet.",
      dryRun: true,
    })
  );

  const marks: number[] = [];
  const scans: Array<{ t: string; action: string; mark: number; reason: string }> = [];
  const closed: ClosedTrade[] = [];
  let open: PaperPos | null = null;
  let nextId = 1;
  let lastScan = 0;
  let forced = 0;

  const seed = await fetchSolMarkUsd();
  marks.push(seed);
  console.log(JSON.stringify({ event: "mark", price: seed, t: new Date().toISOString() }));

  while (Date.now() < endsAt) {
    const mark = await fetchSolMarkUsd().catch((e) => {
      console.log(JSON.stringify({ event: "mark_error", err: String(e) }));
      return marks[marks.length - 1]!;
    });
    marks.push(mark);
    if (marks.length > 80) marks.shift();

    if (open) {
      const pnl = collateralPnlPct(open.side, open.entry, mark, open.leverage);
      const hold = Date.now() - open.openedAt;
      let reason: CloseReason | null = null;
      if (pnl >= TP_PCT) reason = "tp";
      else if (pnl <= -SL_PCT) reason = "sl";
      else if (hold >= MAX_HOLD_MS) reason = "time";
      if (reason) {
        const t = closePos(open, mark, reason);
        closed.push(t);
        appendLearning(t, sessionId);
        console.log(JSON.stringify({ event: "close", ...t }));
        open = null;
      } else {
        console.log(
          JSON.stringify({
            event: "hold",
            id: open.id,
            side: open.side,
            mark,
            collPnlPct: Number(pnl.toFixed(2)),
            holdSec: Number((hold / 1000).toFixed(1)),
          })
        );
      }
    }

    const now = Date.now();
    if (!open && now - lastScan >= SCAN_MS) {
      lastScan = now;
      let rec: YoloScanRec;
      try {
        rec = await scanSolForYolo();
      } catch (e) {
        console.log(JSON.stringify({ event: "scan_error", err: String(e) }));
        rec = {
          action: "DO NOTHING",
          market: "SOL",
          markUsd: mark,
          reason: `scan failed: ${String(e)}`,
          tags: [],
          score: 50,
          bias: "neutral",
        };
      }

      let signal = rec.action;
      let isForced = false;
      const remaining = endsAt - now;
      const needForce =
        closed.length + (open ? 1 : 0) < FORCE_MIN && remaining > MAX_HOLD_MS + 5_000;

      if (signal === "DO NOTHING" && needForce) {
        const side: YoloSide =
          rec.bias === "bearish" || (typeof marks[marks.length - 2] === "number" && mark < marks[marks.length - 2]!)
            ? "SHORT"
            : "LONG";
        signal = side;
        isForced = true;
        forced += 1;
        rec = { ...rec, action: side, reason: `forced paper trade (${rec.reason})` };
        console.log(
          JSON.stringify({
            event: "force_signal",
            signal,
            reason: "signal-starved; forcing paper trade for session coverage",
            forced,
            underlying: rec.reason,
          })
        );
      } else {
        console.log(
          JSON.stringify({
            event: "scan",
            signal,
            mark: rec.markUsd,
            score: rec.score,
            bias: rec.bias,
            tags: rec.tags,
            reason: rec.reason,
          })
        );
      }

      scans.push({
        t: new Date().toISOString(),
        action: signal,
        mark: rec.markUsd,
        reason: rec.reason,
      });

      if (signal === "LONG" || signal === "SHORT") {
        open = {
          id: nextId++,
          side: signal,
          entry: rec.markUsd || mark,
          openedAt: Date.now(),
          leverage: LEVERAGE,
          collateral: COLLATERAL,
          signal: rec,
          forced: isForced,
        };
        console.log(
          JSON.stringify({
            event: "open",
            id: open.id,
            side: open.side,
            entry: open.entry,
            leverage: LEVERAGE,
            collateral: COLLATERAL,
            forced: isForced,
            score: rec.score,
            tags: rec.tags,
          })
        );
      }
    }

    const left = endsAt - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(POLL_MS, left));
  }

  if (open) {
    const mark = marks[marks.length - 1]!;
    const t = closePos(open, mark, "time");
    closed.push(t);
    appendLearning(t, sessionId);
    console.log(JSON.stringify({ event: "close_session_end", ...t }));
    open = null;
  }

  const netPnlUsd = closed.reduce((s, t) => s + t.pnlUsd, 0);
  const netCollPct = closed.reduce((s, t) => s + t.collateralPnlPct, 0);
  const wins = closed.filter((t) => t.collateralPnlPct > 0).length;
  const losses = closed.filter((t) => t.collateralPnlPct < 0).length;
  const flats = closed.length - wins - losses;

  const stamped = path.join(DATA, `${sessionId}.json`);
  const summary = {
    event: "paper_summary",
    sessionId,
    dryRun: true,
    venue: "yolo-paper-mark-proxy",
    signalSource: "scanSolForYolo",
    trades: closed.length,
    wins,
    losses,
    flats,
    forcedSignals: forced,
    netPnlUsd: Number(netPnlUsd.toFixed(4)),
    netCollateralPnlPct: Number(netCollPct.toFixed(2)),
    leverage: LEVERAGE,
    collateralPerTrade: COLLATERAL,
    tpPct: TP_PCT,
    slPct: SL_PCT,
    maxHoldSec: MAX_HOLD_MS / 1000,
    scanSec: SCAN_MS / 1000,
    durationSec: Math.round((Date.now() - started) / 1000),
    firstMark: marks[0],
    lastMark: marks[marks.length - 1],
    scans,
    closed,
    resultsPath: stamped,
    learningsPath: LEARNINGS_JSONL,
  };

  fs.mkdirSync(DATA, { recursive: true });
  const body = JSON.stringify(summary, null, 2) + "\n";
  fs.writeFileSync(stamped, body, "utf8");
  fs.writeFileSync(RESULTS_LATEST, body, "utf8");
  console.log(JSON.stringify({ event: "paper_summary", ...summary, scans: undefined, closed: undefined }, null, 2));
  console.log(`\nWrote ${stamped}`);
  console.log(`Latest ${RESULTS_LATEST}`);
  console.log(`Learnings append → ${LEARNINGS_JSONL}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
