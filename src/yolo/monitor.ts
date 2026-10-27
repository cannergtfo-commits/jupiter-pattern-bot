/**
 * Off-page TP/SL/max-hold for YOLO positions.
 * YOLO has no native TP/SL; bust is ~0.1–0.2% adverse at 500–1000x.
 * We treat TP/SL as collateral PnL % (priceMove% × leverage).
 */
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { YOLO_MAX_HOLD_SECONDS } from "./constants.js";
import { recordClosedTradeLesson } from "../learning.js";
import { collateralPnlPct, fetchSolMarkUsd } from "./mark.js";
import { openYoloPositions } from "./positions-store.js";
import type { YoloDriver } from "./driver.js";
import type { YoloCloseReason } from "./types.js";

export async function monitorYoloPositions(driver: YoloDriver): Promise<void> {
  const opens = openYoloPositions();
  if (!opens.length) return;
  const cfg = loadConfig();
  const mark = await fetchSolMarkUsd();
  const maxHoldMs =
    (cfg.maxHoldSeconds > 0 ? cfg.maxHoldSeconds : YOLO_MAX_HOLD_SECONDS) * 1000;

  for (const pos of opens) {
    const pnl = collateralPnlPct(pos.side, pos.entryMarkUsd, mark, pos.leverage);
    const holdMs = Date.now() - Date.parse(pos.openedAt);
    console.log(
      chalk.white(
        `  YOLO ${pos.side} ${pos.market}: mark=$${mark.toFixed(4)} collPnl=${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}% hold=${Math.round(holdMs / 1000)}s dry=${pos.dryRun}`
      )
    );

    let reason: YoloCloseReason | null = null;
    if (pnl >= cfg.takeProfitPct) reason = "tp";
    else if (pnl <= -cfg.stopLossPct) reason = "sl";
    else if (holdMs >= maxHoldMs) reason = "time";

    if (!reason) continue;

    console.log(
      chalk.magenta(
        `YOLO exit ${pos.side} reason=${reason} collPnl=${pnl.toFixed(2)}% mark=$${mark}`
      )
    );
    const ui = await driver.closePosition(pos.id);
    console.log(chalk.dim(ui.message));
    driver.finalizeClose(pos.id, reason, mark, pnl);

    const lessonReason: "tp" | "sl" | "time" =
      reason === "tp" || reason === "sl" || reason === "time" ? reason : "time";
    try {
      recordClosedTradeLesson({
        position: {
          id: pos.id,
          mint: "YOLO-SOL",
          symbol: `YOLO-${pos.side}-SOL`,
          entryPriceUsd: pos.entryMarkUsd,
          amountToken: 0,
          amountSolSpent: 0,
          takeProfitPct: cfg.takeProfitPct,
          stopLossPct: cfg.stopLossPct,
          openedAt: pos.openedAt,
          status: "closed",
          closeReason: lessonReason,
          closedAt: new Date().toISOString(),
          exitPriceUsd: mark,
          dryRun: pos.dryRun,
          entryMeta: {
            patternTags: [pos.side.toLowerCase()],
            filterNotes: [`yolo lev=${pos.leverage} coll=${pos.collateral} collPnl=${pnl.toFixed(2)}%`],
          },
        },
        reason: lessonReason,
        exitPriceUsd: mark,
      });
    } catch (e) {
      console.log(chalk.dim(`learning record failed: ${(e as Error).message}`));
    }
  }
}
