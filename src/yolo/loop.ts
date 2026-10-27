/**
 * YOLO venue loop: 30s scan → LONG/SHORT/DO NOTHING → browser open (dry by default)
 * → 5s poll for TP +50% / SL −20% / max hold 40s.
 */
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { YoloDriver, defaultYoloConfig } from "./driver.js";
import { monitorYoloPositions } from "./monitor.js";
import { hasOpenYolo } from "./positions-store.js";
import { scanSolForYolo } from "./scan-sol.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface YoloLoopOpts {
  once?: boolean;
  /** Override duration for paper sessions (ms). 0 = forever. */
  durationMs?: number;
  forceTradeIfIdle?: boolean;
}

export async function runYoloLoop(opts: YoloLoopOpts = {}): Promise<void> {
  const cfg = loadConfig();
  const live =
    !cfg.dryRun &&
    ["1", "true", "yes", "on"].includes(String(process.env.YOLO_LIVE || "").toLowerCase());
  const driver = new YoloDriver(
    defaultYoloConfig({
      dryRun: cfg.dryRun || !live,
      liveEnabled: live,
      headless: !["0", "false", "no"].includes(String(process.env.YOLO_HEADLESS || "true").toLowerCase()),
      collateral: Number(process.env.YOLO_COLLATERAL || 5),
      leverage: Number(process.env.YOLO_LEVERAGE || 500),
      userDataDir: process.env.YOLO_USER_DATA_DIR || undefined,
    })
  );

  console.log(chalk.bold("\n══ YOLO browser loop ══"));
  console.log(
    chalk.yellow(
      `dryRun=${driver.cfg.dryRun} liveEnabled=${driver.cfg.liveEnabled} coll=${driver.cfg.collateral} lev=${driver.cfg.leverage}x TP=+${cfg.takeProfitPct}% SL=-${cfg.stopLossPct}% maxHold=${cfg.maxHoldSeconds}s`
    )
  );
  for (const n of driver.fragilityNotes().slice(0, 4)) {
    console.log(chalk.dim(`  • ${n}`));
  }

  const nav = await driver.openBrowser();
  console.log(nav.ok ? chalk.green(nav.message) : chalk.red(nav.message + " " + (nav.error ?? "")));
  if (nav.screenshotPath) console.log(chalk.dim(`  shot: ${nav.screenshotPath}`));

  const started = Date.now();
  const duration = opts.durationMs ?? 0;
  let lastScan = 0;

  const tickScan = async () => {
    const rec = await scanSolForYolo();
    const color =
      rec.action === "LONG"
        ? chalk.green.bold
        : rec.action === "SHORT"
          ? chalk.red.bold
          : chalk.yellow.bold;
    console.log("");
    console.log(chalk.bold("════════════ YOLO SCAN ════════════"));
    console.log(color(`  >>> ${rec.action} <<<  SOL @ $${rec.markUsd.toFixed(4)}`));
    console.log(chalk.dim(`  why: ${rec.reason}`));
    console.log(chalk.bold("═══════════════════════════════════"));

    if (hasOpenYolo()) {
      console.log(chalk.dim("  open YOLO position — skip new entry"));
      return;
    }

    let action = rec.action;
    if (
      action === "DO NOTHING" &&
      opts.forceTradeIfIdle &&
      !hasOpenYolo()
    ) {
      action = rec.bias === "bearish" ? "SHORT" : "LONG";
      console.log(chalk.cyan(`  force paper entry → ${action}`));
    }

    if (action === "LONG" || action === "SHORT") {
      const open = await driver.openPosition({
        side: action,
        entryMarkUsd: rec.markUsd,
        note: rec.reason,
      });
      console.log(open.ok ? chalk.green(open.message) : chalk.red(open.message));
      if (open.screenshotPath) console.log(chalk.dim(`  shot: ${open.screenshotPath}`));
      // Kick a monitor pass soon so 40s max-hold is measured from open, not from next poll only
      await sleep(Math.min(5_000, cfg.positionPollMs || 5_000));
      await monitorYoloPositions(driver);
    }
  };

  try {
    await tickScan();
    lastScan = Date.now();
    if (opts.once) {
      await monitorYoloPositions(driver);
      return;
    }
    for (;;) {
      if (duration > 0 && Date.now() - started >= duration) break;
      const poll = Math.max(1_000, Math.min(cfg.positionPollMs || 5_000, 10_000));
      await sleep(poll);
      try {
        await monitorYoloPositions(driver);
      } catch (e) {
        console.log(chalk.red(`YOLO monitor: ${(e as Error).message}`));
      }
      if (Date.now() - lastScan >= cfg.scanIntervalMs) {
        lastScan = Date.now();
        try {
          await tickScan();
        } catch (e) {
          console.log(chalk.red(`YOLO scan: ${(e as Error).message}`));
        }
      }
    }
    // Final monitor + flatten time-exits
    await monitorYoloPositions(driver);
  } finally {
    await driver.close();
  }
}
