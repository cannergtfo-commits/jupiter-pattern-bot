/**
 * Background trading engine: only scans/buys/exits while bot.armed === true.
 * Dashboards toggle arm/disarm via state.ts; UI refresh is separate.
 * Cross-process lock prevents duplicate engines (web + tui + run) fighting.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ROOT } from "./config.js";
import { loadBotState, markTick, markTicking } from "./bot-state.js";
import { monitorPositions, scanOnce, tryEnter } from "./strategy.js";
import { sortForTryEnter } from "./confluence.js";
import { printScanRecommendation } from "./recommend.js";

const LOCK_PATH = path.join(ROOT, "data", "engine.lock");

let timer: NodeJS.Timeout | null = null;
let monitorTimer: NodeJS.Timeout | null = null;
let running = false;
let holdsLock = false;

function tryAcquireLock(): boolean {
  try {
    const dir = path.dirname(LOCK_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Stale lock: if pid is dead, take over
    if (fs.existsSync(LOCK_PATH)) {
      try {
        const prev = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as { pid?: number };
        if (prev.pid && prev.pid !== process.pid) {
          try {
            process.kill(prev.pid, 0);
            return false; // other live process holds lock
          } catch {
            /* dead pid — steal */
          }
        }
      } catch {
        /* corrupt — steal */
      }
    }
    fs.writeFileSync(
      LOCK_PATH,
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n",
      "utf8"
    );
    holdsLock = true;
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  if (!holdsLock) return;
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const prev = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as { pid?: number };
      if (prev.pid === process.pid) fs.unlinkSync(LOCK_PATH);
    }
  } catch {
    /* ignore */
  }
  holdsLock = false;
}

async function tickOnce(): Promise<void> {
  const state = loadBotState();
  if (!state.armed) {
    markTick("disarmed — idle (no scan/buy/exit)");
    return;
  }
  if (running) return;
  running = true;
  markTicking(true);
  try {
    const cfg = loadConfig();
    if (cfg.tradeVenue === "yolo") {
      // YOLO venue: one scan+optional open handled by yolo loop helpers (dry by default)
      const { scanSolForYolo } = await import("./yolo/scan-sol.js");
      const { hasOpenYolo } = await import("./yolo/positions-store.js");
      const { YoloDriver, defaultYoloConfig } = await import("./yolo/driver.js");
      const { monitorYoloPositions } = await import("./yolo/monitor.js");
      const live =
        !cfg.dryRun &&
        ["1", "true", "yes", "on"].includes(String(process.env.YOLO_LIVE || "").toLowerCase());
      const driver = new YoloDriver(
        defaultYoloConfig({
          dryRun: cfg.dryRun || !live,
          liveEnabled: live,
          collateral: cfg.yoloCollateral,
          leverage: cfg.yoloLeverage,
          headless: true,
        })
      );
      try {
        await monitorYoloPositions(driver);
        const rec = await scanSolForYolo();
        console.log(`[yolo] >>> ${rec.action} <<< SOL @ $${rec.markUsd.toFixed(4)} — ${rec.reason}`);
        if (!hasOpenYolo() && (rec.action === "LONG" || rec.action === "SHORT")) {
          const open = await driver.openPosition({
            side: rec.action,
            entryMarkUsd: rec.markUsd,
            note: rec.reason,
          });
          console.log(open.message);
        }
        markTick(`yolo tick: rec=${rec.action} mark=${rec.markUsd} dry=${driver.cfg.dryRun}`);
      } finally {
        await driver.close();
      }
      return;
    }

    await monitorPositions();
    const rows = await scanOnce();
    const rec = printScanRecommendation(rows, cfg);
    const passes = sortForTryEnter(
      rows.filter((r) => r.filterPass),
      cfg
    );
    // Spot path only opens on LONG. SHORT/DO NOTHING = signal unless TRADE_VENUE=yolo.
    if (rec.action === "LONG") {
      for (const r of passes.slice(0, 5)) {
        if (!loadBotState().armed) break;
        await tryEnter(r.token);
      }
    }
    markTick(
      `armed tick: rec=${rec.action} checked=${rows.length} pass=${passes.length} topConf=${passes[0]?.confluenceScore ?? "—"}`
    );
  } catch (e) {
    markTick("tick failed", (e as Error).message);
  } finally {
    running = false;
    markTicking(false);
  }
}

/** Start interval that respects armed flag each tick. Idempotent. Single-process lock. */
export function startEngine(): void {
  if (timer) return;
  if (!tryAcquireLock()) {
    // Another live process already owns the trading engine — UI-only mode
    // Do not clobber lastTickSummary owned by the engine process.
    console.log("[engine] lock held by another process — this process is UI-only");
    return;
  }
  const cfg = loadConfig();
  const interval = Math.max(5_000, cfg.scanIntervalMs);
  const poll = Math.max(1_000, Math.min(cfg.positionPollMs || 5_000, 10_000));
  void tickOnce();
  timer = setInterval(() => {
    void tickOnce();
  }, interval);
  // Separate monitor so maxHoldSeconds (e.g. 40s) is honored between 30s scans
  monitorTimer = setInterval(() => {
    if (!loadBotState().armed) return;
    if (cfg.tradeVenue === "yolo") {
      void (async () => {
        const { YoloDriver, defaultYoloConfig } = await import("./yolo/driver.js");
        const { monitorYoloPositions } = await import("./yolo/monitor.js");
        const live =
          !cfg.dryRun &&
          ["1", "true", "yes", "on"].includes(String(process.env.YOLO_LIVE || "").toLowerCase());
        const driver = new YoloDriver(
          defaultYoloConfig({
            dryRun: cfg.dryRun || !live,
            liveEnabled: live,
            collateral: cfg.yoloCollateral,
            leverage: cfg.yoloLeverage,
            headless: true,
          })
        );
        try {
          await monitorYoloPositions(driver);
        } finally {
          await driver.close();
        }
      })().catch(() => undefined);
      return;
    }
    void monitorPositions().catch(() => undefined);
  }, poll);
}

export function stopEngine(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  running = false;
  markTicking(false);
  releaseLock();
}

export function isEngineStarted(): boolean {
  return timer !== null;
}

export async function forceTick(): Promise<void> {
  // Manual tick always allowed from UI even if this process is UI-only
  await tickOnce();
}

process.on("exit", releaseLock);
process.on("SIGINT", releaseLock);
process.on("SIGTERM", releaseLock);
