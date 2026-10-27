/**
 * One LIVE YOLO trade at min 5 JupUSD, then force-close by 40s.
 * Requires Connect via injected wallet. Reverts DRY_RUN on exit.
 * NEVER logs the private key.
 */
import { YoloDriver, defaultYoloConfig } from "../src/yolo/driver.js";
import { scanSolForYolo } from "../src/yolo/scan-sol.js";
import { fetchSolMarkUsd, collateralPnlPct } from "../src/yolo/mark.js";
import { openYoloPositions } from "../src/yolo/positions-store.js";
import { YOLO_HARNESS } from "../src/yolo/constants.js";
import { getAddress } from "../src/wallet.js";
import { clampYoloCollateral } from "../src/yolo/injected-wallet.js";

const COLLATERAL = clampYoloCollateral(Number(process.env.YOLO_COLLATERAL || 5));
const LEVERAGE = Number(process.env.YOLO_LEVERAGE || 500);

async function main() {
  const prevDry = process.env.DRY_RUN;
  const prevLive = process.env.YOLO_LIVE;
  process.env.DRY_RUN = "false";
  process.env.YOLO_LIVE = "true";
  process.env.YOLO_INJECT_WALLET = "true";
  process.env.YOLO_HEADLESS = process.env.YOLO_HEADLESS || "false";

  const pub = getAddress();
  console.log("=== YOLO one-live (5 JupUSD min) ===");
  console.log("public:", pub);
  console.log("collateral:", COLLATERAL, "leverage:", LEVERAGE);
  console.log("Secret stays in Node — never printed.");

  const driver = new YoloDriver(
    defaultYoloConfig({
      dryRun: false,
      liveEnabled: true,
      headless: !["0", "false", "no"].includes(String(process.env.YOLO_HEADLESS || "false").toLowerCase()),
      injectWallet: true,
      collateral: COLLATERAL,
      leverage: LEVERAGE,
      userDataDir: process.env.YOLO_USER_DATA_DIR || undefined,
    })
  );

  try {
    const nav = await driver.openBrowser();
    console.log(nav.ok ? nav.message : "NAV FAIL " + nav.error);
    if (!nav.ok) process.exitCode = 1;
    else {
      const conn = await driver.connectWallet();
      console.log(conn.ok ? conn.message : "CONNECT FAIL " + conn.error);
      if (!conn.ok) {
        process.exitCode = 1;
      } else {
        const rec = await scanSolForYolo();
        let side = rec.action === "SHORT" ? "SHORT" : "LONG";
        if (rec.action === "DO NOTHING") {
          side = rec.bias === "bearish" ? "SHORT" : "LONG";
          console.log("scan DO NOTHING — forcing", side, "for one-live");
        }
        const mark = rec.markUsd || (await fetchSolMarkUsd());
        console.log("opening", side, "@", mark);
        const opened = await driver.openPosition({
          side: side as "LONG" | "SHORT",
          entryMarkUsd: mark,
          collateral: COLLATERAL,
          leverage: LEVERAGE,
          note: "one-live",
        });
        console.log(opened.ok ? opened.message : "OPEN FAIL " + opened.error);
        if (!opened.ok) process.exitCode = 1;
        else {
          const posId = opened.positionId!;
          const openedAt = Date.now();
          const deadline = openedAt + YOLO_HARNESS.maxHoldMs;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, YOLO_HARNESS.positionPollMs));
            const markNow = await fetchSolMarkUsd();
            const opens = openYoloPositions();
            const pos = opens.find((p) => p.id === posId);
            if (!pos) break;
            const pnl = collateralPnlPct(pos.side, pos.entryMarkUsd, markNow, pos.leverage);
            console.log("mark", markNow, "pnl%", pnl.toFixed(2));
            if (pnl >= 50 || pnl <= -20) {
              console.log("TP/SL hit — closing");
              break;
            }
          }
          // Respect 15s YOLO lockout then close (UI refuses earlier)
          const age = Date.now() - openedAt;
          if (age < 15_000) {
            console.log("waiting for 15s YOLO close lockout…");
            await new Promise((r) => setTimeout(r, 15_000 - age + 800));
          }
          let closed = await driver.closePosition(posId);
          if (!closed.ok && closed.error === "none_open") {
            // Store may already be finalized by a concurrent monitor — still try UI Close
            closed = await driver.closePosition();
          }
          console.log(closed.ok ? closed.message : "CLOSE FAIL " + closed.error);
          const exitMark = await fetchSolMarkUsd();
          const pos = openYoloPositions().find((p) => p.id === posId);
          if (pos) {
            const pnl = collateralPnlPct(pos.side, pos.entryMarkUsd, exitMark, pos.leverage);
            driver.finalizeClose(posId, "time", exitMark, pnl);
            console.log("finalized pnl%", pnl.toFixed(2), "exit", exitMark);
          } else {
            // already closed in store or finalize via monitor path
            const all = (await import("../src/yolo/positions-store.js")).loadYoloPositions();
            const p = all.find((x) => x.id === posId);
            if (p && p.status === "open") {
              const pnl = collateralPnlPct(p.side, p.entryMarkUsd, exitMark, p.leverage);
              driver.finalizeClose(posId, "time", exitMark, pnl);
            }
          }
        }
      }
    }
  } finally {
    await driver.close().catch(() => undefined);
    process.env.DRY_RUN = prevDry ?? "true";
    if (prevLive === undefined) delete process.env.YOLO_LIVE;
    else process.env.YOLO_LIVE = prevLive;
    console.log("reverted DRY_RUN=", process.env.DRY_RUN, "YOLO_LIVE=", process.env.YOLO_LIVE ?? "(unset)");
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.env.DRY_RUN = "true";
  delete process.env.YOLO_LIVE;
  process.exitCode = 1;
});
