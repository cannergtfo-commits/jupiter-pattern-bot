/**
 * Mark-proxy YOLO paper CLI (no browser, no wallet, no signing).
 *
 *   npm run paper
 *   npm run paper -- --minutes 10
 *   npm run paper -- --minutes 15 --force-min 4
 *   npm run bot -- yolo paper --minutes 10
 *
 * Writes data/paper-yolo-session.json (+ stamped copy) and appends
 * data/paper-learnings.jsonl. Also records via learning.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  YOLO_DEFAULT_COLLATERAL,
  YOLO_DEFAULT_LEVERAGE,
  YOLO_DEFAULT_SL_PCT,
  YOLO_DEFAULT_TP_PCT,
  YOLO_MAX_HOLD_MS,
  YOLO_POSITION_POLL_MS,
  YOLO_SCAN_INTERVAL_MS,
} from "../src/yolo/constants.js";
import { runPaperHarness, type PaperSignal } from "../src/yolo/paper-engine.js";
import { scanSolForYolo } from "../src/yolo/scan-sol.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const LEARNINGS_JSONL = path.join(DATA, "paper-learnings.jsonl");

function numFlag(argv: string[], flag: string, envKeys: string[], fallback: number): number {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
    const n = Number(argv[i + 1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  for (const k of envKeys) {
    const e = process.env[k];
    if (e != null && e !== "" && Number.isFinite(Number(e))) return Number(e);
  }
  return fallback;
}

function asSec(n: number, defaultSec: number): number {
  if (!Number.isFinite(n) || n <= 0) return defaultSec;
  return n > 200 ? n / 1000 : n;
}

function parseArgs(argv: string[]) {
  let minutes = numFlag(argv, "--minutes", ["PAPER_MINUTES"], 5);
  if (!argv.includes("--minutes") && process.env.PAPER_DURATION_MS) {
    const ms = Number(process.env.PAPER_DURATION_MS);
    if (Number.isFinite(ms) && ms > 0) minutes = ms / 60_000;
  }
  const useSkill = !argv.includes("--momentum-only") && process.env.PAPER_MOMENTUM_ONLY !== "1";
  return {
    minutes: Math.max(1, Math.min(60, minutes)),
    scanSec: asSec(numFlag(argv, "--scan-sec", ["PAPER_SCAN_SEC", "PAPER_SCAN_MS"], YOLO_SCAN_INTERVAL_MS / 1000), 30),
    pollSec: asSec(numFlag(argv, "--poll-sec", ["PAPER_POLL_SEC", "PAPER_POLL_MS"], YOLO_POSITION_POLL_MS / 1000), 5),
    maxHoldSec: asSec(
      numFlag(argv, "--max-hold-sec", ["PAPER_MAX_HOLD_SEC", "PAPER_MAX_HOLD_MS"], YOLO_MAX_HOLD_MS / 1000),
      40
    ),
    tp: numFlag(argv, "--tp", ["PAPER_TP_PCT"], YOLO_DEFAULT_TP_PCT),
    sl: numFlag(argv, "--sl", ["PAPER_SL_PCT"], YOLO_DEFAULT_SL_PCT),
    leverage: numFlag(argv, "--leverage", ["PAPER_LEVERAGE"], YOLO_DEFAULT_LEVERAGE),
    collateral: numFlag(argv, "--collateral", ["PAPER_COLLATERAL"], YOLO_DEFAULT_COLLATERAL),
    forceMin: numFlag(argv, "--force-min", ["PAPER_FORCE_MIN"], 2),
    useSkill,
  };
}

async function skillSignal(): Promise<{ signal: PaperSignal; note: string; meta?: Record<string, unknown> }> {
  try {
    const rec = await scanSolForYolo();
    return {
      signal: rec.action,
      note: rec.reason,
      meta: { score: rec.score, bias: rec.bias, tags: rec.tags, markUsd: rec.markUsd },
    };
  } catch (e) {
    return { signal: "DO NOTHING", note: `scanSolForYolo failed: ${String(e)}` };
  }
}

function appendJsonl(trade: {
  id: string;
  side: string;
  entry: number;
  exit: number;
  reason: string;
  holdSec: number;
  collateralPnlPct: number;
  pnlUsd: number;
  closedAt: string;
  lessonId?: string;
}, sessionId: string, leverage: number): void {
  fs.mkdirSync(DATA, { recursive: true });
  const outcome =
    trade.collateralPnlPct > 0 ? "win" : trade.collateralPnlPct < 0 ? "loss" : "flat";
  const lesson =
    trade.reason === "tp"
      ? `WIN TP ${trade.side} collPnl=${trade.collateralPnlPct}%`
      : trade.reason === "sl"
        ? `LOSS SL ${trade.side} collPnl=${trade.collateralPnlPct}%`
        : `${outcome.toUpperCase()} TIME ${trade.side} held ${trade.holdSec}s collPnl=${trade.collateralPnlPct}%`;
  fs.appendFileSync(
    LEARNINGS_JSONL,
    JSON.stringify({
      at: trade.closedAt,
      sessionId,
      venue: "yolo-paper-mark-proxy",
      dryRun: true,
      outcome,
      reason: trade.reason,
      side: trade.side,
      entry: trade.entry,
      exit: trade.exit,
      collateralPnlPct: trade.collateralPnlPct,
      pnlUsd: trade.pnlUsd,
      holdSec: trade.holdSec,
      leverage,
      lessonId: trade.lessonId,
      lesson,
    }) + "\n",
    "utf8"
  );
}

async function main(): Promise<void> {
  process.env.DRY_RUN = process.env.DRY_RUN || "true";
  const opts = parseArgs(process.argv.slice(2));
  const sessionId = `paper-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const stamped = path.join(DATA, `${sessionId}.json`);
  const latest = path.join(DATA, "paper-yolo-session.json");

  const summary = await runPaperHarness({
    durationMs: opts.minutes * 60_000,
    scanMs: opts.scanSec * 1000,
    pollMs: opts.pollSec * 1000,
    maxHoldMs: opts.maxHoldSec * 1000,
    tpPct: opts.tp,
    slPct: opts.sl,
    leverage: opts.leverage,
    collateral: opts.collateral,
    forceMinTrades: opts.forceMin,
    recordLessons: process.env.PAPER_RECORD_LESSONS !== "0",
    outPath: latest,
    signalFetcher: opts.useSkill ? skillSignal : undefined,
    sessionId,
  });

  for (const t of summary.closed) {
    appendJsonl(t, sessionId, opts.leverage);
  }

  const stampedBody = JSON.stringify(
    {
      event: "paper_summary",
      sessionId,
      dryRun: true,
      signalSource: opts.useSkill ? "scanSolForYolo" : "momentum",
      learningsPath: LEARNINGS_JSONL,
      ...summary,
    },
    null,
    2
  ) + "\n";
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(stamped, stampedBody, "utf8");
  fs.writeFileSync(latest, stampedBody, "utf8");

  console.log(
    `\nPaper done: trades=${summary.trades} wins=${summary.wins} netColl=${summary.netCollateralPnlPct}% maxHold=${summary.maxHoldSec}s scan=${summary.scanSec}s`
  );
  console.log(`Wrote ${stamped}`);
  console.log(`Latest ${latest}`);
  console.log(`Learnings append → ${LEARNINGS_JSONL}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
