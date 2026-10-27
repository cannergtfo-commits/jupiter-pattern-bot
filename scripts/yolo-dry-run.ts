/**
 * One-shot YOLO dry-run harness: open page (if Chromium available), screenshot,
 * simulate LONG then close after monitor rules — never signs.
 */
import chalk from "chalk";
import { runYoloLoop } from "../src/yolo/loop.js";
import { loadYoloPositions } from "../src/yolo/positions-store.js";

async function main(): Promise<void> {
  process.env.DRY_RUN = "true";
  delete process.env.YOLO_LIVE;
  console.log(chalk.bold("YOLO dry-run harness — DRY_RUN forced, no signing"));
  await runYoloLoop({
    durationMs: Number(process.env.YOLO_DRY_DURATION_MS || 90_000),
    forceTradeIfIdle: true,
  });
  const all = loadYoloPositions();
  const closed = all.filter((p) => p.status === "closed");
  const open = all.filter((p) => p.status === "open");
  console.log(chalk.bold("\n=== Dry-run positions ==="));
  for (const p of [...closed, ...open]) {
    console.log(
      `  ${p.status} ${p.side} entry=$${p.entryMarkUsd} exit=${p.exitMarkUsd ?? "—"} pnl=${p.collateralPnlPct ?? "—"}% reason=${p.closeReason ?? "—"} dry=${p.dryRun}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
