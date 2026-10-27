#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, saveFilters } from "./config.js";
import { describeFilters, parseFilterSet } from "./filters.js";
import {
  createWallet,
  encryptExistingWallet,
  getAddress,
  getBalanceSol,
  withdrawSol,
  walletExists,
  safeWalletInfo,
} from "./wallet.js";
import { scanOnce, runLoop } from "./strategy.js";
import { openPositions, loadPositions } from "./positions.js";
import { rpcHealthy } from "./security-checks.js";
import {
  buildSnapshot,
  getBotState,
  armBot,
  disarmBot,
  toggleBotArmed,
} from "./state.js";
import { startEngine, stopEngine, forceTick, isEngineStarted } from "./engine.js";
import { recentTx, explorerTxUrl } from "./history.js";

const program = new Command();

program
  .name("jupiter-pattern-bot")
  .description("Jupiter pattern bot — solana-skill candles/volume, Jupiter APIs, TP+50% / SL-20%")
  .version("1.0.0");

const wallet = program.command("wallet").description("Manage the bot wallet");

wallet
  .command("create")
  .description("Generate a local wallet under .wallet/ (0600; encrypt if WALLET_PASSWORD set)")
  .action(() => {
    try {
      const { publicKey, path, encrypted } = createWallet();
      console.log(chalk.green(encrypted ? "Encrypted keystore created." : "Wallet created (file mode 0600)."));
      console.log(chalk.bold("Public address:"), publicKey);
      console.log(chalk.dim(`Secret file: ${path} (never share / never paste into chat)`));
      console.log(chalk.yellow("Fund this PUBLIC address only. Keep DRY_RUN=true until you intend live trades."));
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exitCode = 1;
    }
  });

wallet
  .command("encrypt")
  .description("Upgrade plaintext keypair.json → AES-256-GCM keystore (needs WALLET_PASSWORD)")
  .action(() => {
    try {
      const pwd = process.env.WALLET_PASSWORD;
      if (!pwd) {
        console.error(chalk.red("Set WALLET_PASSWORD in .env first (gitignored)."));
        process.exitCode = 1;
        return;
      }
      const { publicKey, path } = encryptExistingWallet(pwd);
      console.log(chalk.green("Wallet encrypted."));
      console.log(chalk.bold("Public address:"), publicKey);
      console.log(chalk.dim(`Keystore: ${path}`));
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exitCode = 1;
    }
  });

wallet
  .command("address")
  .description("Print public address only")
  .action(() => {
    try {
      if (!walletExists()) {
        console.error(chalk.red("No wallet. Run: npm run bot -- wallet create"));
        process.exitCode = 1;
        return;
      }
      console.log(getAddress());
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exitCode = 1;
    }
  });

wallet
  .command("balance")
  .description("Show SOL balance")
  .action(async () => {
    try {
      const bal = await getBalanceSol();
      console.log(chalk.bold("Address:"), getAddress());
      console.log(chalk.bold("Balance:"), `${bal.toFixed(6)} SOL`);
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exitCode = 1;
    }
  });

wallet
  .command("withdraw")
  .argument("<pubkey>", "Destination Solana address")
  .argument("<sol>", "Amount of SOL")
  .option("--yes", "Confirm dest + amount (required)")
  .description("Send SOL from bot wallet to an external pubkey (requires --yes)")
  .action(async (pubkey: string, solStr: string, opts: { yes?: boolean }) => {
    try {
      const amount = Number(solStr);
      if (!(amount > 0) || !Number.isFinite(amount)) {
        throw new Error("Amount must be a positive number");
      }
      const cfg = loadConfig();
      console.log(chalk.bold("Withdraw preview (secret key never shown):"));
      console.log(`  from:   ${getAddress()}`);
      console.log(`  to:     ${pubkey}`);
      console.log(`  amount: ${amount} SOL`);
      console.log(`  dryRun: ${cfg.dryRun}`);
      if (!opts.yes) {
        console.log(chalk.yellow("Re-run with --yes to confirm."));
        process.exitCode = 1;
        return;
      }
      if (cfg.dryRun) {
        console.log(chalk.yellow("DRY_RUN=true — withdraw simulated. Set DRY_RUN=false for live."));
      }
      const result = await withdrawSol(pubkey, amount, { confirm: true });
      console.log(chalk.green(result));
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exitCode = 1;
    }
  });

const filtersCmd = program.command("filters").description("Show or set buy-block risk filters");

filtersCmd
  .command("show")
  .description("Print current filters")
  .action(() => {
    const cfg = loadConfig();
    console.log(chalk.bold("Risk filters (buys blocked when rules fail):\n"));
    console.log(describeFilters(cfg.filters));
    console.log(chalk.dim("\nExample: npm run bot -- filters set maxTopHolderPercent 15"));
  });

filtersCmd
  .command("set")
  .argument("<key>", "e.g. maxTopHolderPercent")
  .argument("<value>", "New value")
  .description("Set a filter key")
  .action((key: string, value: string) => {
    try {
      const cfg = loadConfig();
      const next = parseFilterSet(key, value, cfg.filters);
      saveFilters(next);
      console.log(chalk.green(`Updated ${key}`));
      console.log(describeFilters(next));
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exitCode = 1;
    }
  });

program
  .command("scan")
  .description("Scan markets; print candidates and why rejected")
  .action(async () => {
    console.log(chalk.bold("Scanning markets…"));
    try {
      const rows = await scanOnce();
      if (!rows.length) {
        console.log(chalk.yellow("No candidates (rate limits or empty). Try again later."));
        return;
      }
      for (const r of rows) {
        const t = r.token;
        const head = `${t.symbol.padEnd(10)} ${t.mint.slice(0, 8)}… liq=$${t.liquidityUsd.toFixed(0)} vol24=$${t.volume24hUsd.toFixed(0)} spike=${t.volumeSpikeRatio.toFixed(2)}x src=${t.source}`;
        if (r.filterPass) {
          console.log(chalk.green("PASS  " + head));
        } else {
          console.log(chalk.red("BLOCK " + head));
          console.log(chalk.dim("      " + r.filterReasons.join(" | ")));
        }
        if (r.safetyNote) console.log(chalk.dim("      safety: " + r.safetyNote));
        if (r.twitter) console.log(chalk.dim("      twitter: " + r.twitter));
      }
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exitCode = 1;
    }
  });

program
  .command("run")
  .option("--once", "Single tick then exit")
  .description("Arm bot and loop: scan → filter → buy → monitor TP/SL")
  .action(async (opts: { once?: boolean }) => {
    const cfg = loadConfig();
    if (!walletExists()) {
      console.error(chalk.red("Create a wallet first: npm run bot -- wallet create"));
      process.exitCode = 1;
      return;
    }
    if (cfg.dryRun) {
      console.log(chalk.yellow("DRY_RUN=true — swaps logged, not sent. Set DRY_RUN=false for live."));
    } else {
      console.log(chalk.red.bold("LIVE MODE — real swaps. Use small funds only."));
    }
    try {
      await runLoop({ once: !!opts.once });
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exitCode = 1;
    }
  });

const botCmd = program.command("bot").description("Arm/disarm trading engine (BOT ON/OFF)");

botCmd
  .command("status")
  .description("Show BOT ON/OFF and last tick")
  .action(() => {
    const s = getBotState();
    console.log(chalk.bold(`BOT: ${s.armed ? chalk.green("ON") : chalk.red("OFF")}`));
    console.log(`UI refresh: ${s.uiRefresh} (${s.uiRefreshMs}ms)`);
    console.log(`Last tick:  ${s.lastTickAt ?? "never"}`);
    console.log(`Summary:    ${s.lastTickSummary ?? "-"}`);
    if (s.lastError) console.log(chalk.red(`Error:      ${s.lastError}`));
    console.log(`Engine:     ${isEngineStarted() ? "started" : "stopped"}`);
  });

botCmd
  .command("on")
  .description("Arm trading flag (scan+buy+exits when an engine is running)")
  .action(() => {
    armBot();
    console.log(chalk.green("BOT ON — armed. Start a loop with: run | dashboard | web | bot tick"));
  });

botCmd
  .command("off")
  .description("Disarm trading")
  .action(() => {
    disarmBot();
    console.log(chalk.yellow("BOT OFF — scanning/buying/exits will not run"));
  });

botCmd
  .command("toggle")
  .description("Toggle BOT ON/OFF")
  .action(() => {
    const s = toggleBotArmed();
    console.log(s.armed ? chalk.green("BOT ON") : chalk.yellow("BOT OFF"));
  });

botCmd
  .command("tick")
  .description("Run a single engine tick (only acts if armed), then exit")
  .action(async () => {
    await forceTick();
    const s = getBotState();
    console.log(s.lastTickSummary ?? "done");
    if (s.lastError) console.log(chalk.red(s.lastError));
  });

program
  .command("status")
  .description("Wallet, config, open positions, bot arm state")
  .action(async () => {
    const cfg = loadConfig();
    const info = safeWalletInfo();
    const bot = getBotState();
    console.log(chalk.bold("=== Bot status ==="));
    console.log(`BOT:          ${bot.armed ? chalk.green("ON") : chalk.red("OFF")}`);
    console.log(`Wallet exists: ${info.exists}`);
    if (info.exists) {
      console.log(`Address:      ${info.address}`);
      console.log(`Keypair:      ${info.keypairPath}`);
      try {
        const bal = await getBalanceSol();
        console.log(`Balance:      ${bal.toFixed(6)} SOL`);
      } catch (e) {
        console.log(chalk.yellow(`Balance:      (RPC error: ${(e as Error).message})`));
      }
    }
    console.log(`RPC healthy:  ${await rpcHealthy()}`);
    console.log(`Dry run:      ${cfg.dryRun}`);
    console.log(`Buy amount:   ${cfg.buyAmountSol} SOL (cap ${cfg.maxBuyAmountSol})`);
    console.log(`TP / SL:      +${cfg.takeProfitPct}% / -${cfg.stopLossPct}%`);
    console.log(
      `Max hold:     ${
        cfg.maxHoldSeconds > 0
          ? cfg.maxHoldSeconds + "s hard"
          : cfg.maxHoldMinutes > 0
            ? cfg.maxHoldMinutes + "m"
            : "off"
      }`
    );
    console.log(`Scan / poll:  ${cfg.scanIntervalMs}ms / ${cfg.positionPollMs}ms`);
    // wallet enc from info above
    console.log(`Wallet enc:   ${info.encrypted ? "keystore (AES-GCM)" : info.exists ? "keypair.json 0600" : "none"}`);
    console.log(`Early red:    ${cfg.earlyRedCutMinutes > 0 ? cfg.earlyRedCutMinutes + "m if ≤" + cfg.earlyRedCutMaxPct + "%" : "off"}`);
    console.log(`Min pref tags:${cfg.minPreferredTagCount > 0 ? cfg.minPreferredTagCount : "off"}`);
    console.log(`Reentry CD:   ${cfg.reentryCooldownMinutes > 0 ? cfg.reentryCooldownMinutes + "m (pump bypass 5m≥" + cfg.reentryVolumePumpPct + "% spike≥" + cfg.reentryVolumeSpikeMin + "x)" : "off"}`);
    console.log(`Auto deny:    SL=${cfg.autoDenylistOnSl} redCut=${cfg.autoDenylistOnRedCut} afterLosses=${cfg.autoDenylistAfterLosses || "off"}`);
    console.log(`Slippage:     ${cfg.slippageBps} bps`);
    console.log(chalk.bold("\nFilters:"));
    console.log(describeFilters(cfg.filters));
    const open = openPositions();
    console.log(chalk.bold(`\nOpen positions: ${open.length}`));
    for (const p of open) {
      console.log(
        `  ${p.symbol} mint=${p.mint.slice(0, 8)}… entry=$${p.entryPriceUsd} spent=${p.amountSolSpent} SOL dry=${p.dryRun}`
      );
    }
    const all = loadPositions().positions;
    console.log(chalk.dim(`Closed (history): ${all.filter((p) => p.status === "closed").length}`));
    const txs = recentTx(5);
    console.log(chalk.bold(`\nRecent txs: ${txs.length}`));
    for (const t of txs) {
      const sig = t.signature ? explorerTxUrl(t.signature) : "(dry/no sig)";
      console.log(
        `  [${t.kind}] ${t.symbol ?? ""} ${t.amountSol ?? ""} SOL ${t.dryRun ? "DRY" : ""} ${sig}`
      );
    }
  });

program
  .command("history")
  .description("Show recent buy/sell/withdraw records")
  .option("-n, --limit <n>", "rows", "20")
  .action((opts: { limit: string }) => {
    const rows = recentTx(Number(opts.limit) || 20);
    if (!rows.length) {
      console.log(chalk.dim("No transactions yet."));
      return;
    }
    for (const t of rows) {
      const when = new Date(t.timestamp).toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
      const pnl =
        t.pnlPct !== undefined ? ` pnl=${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}%` : "";
      const link = t.signature ? explorerTxUrl(t.signature) : "";
      console.log(
        `${when}  ${t.kind.toUpperCase().padEnd(8)} ${(t.symbol ?? "-").padEnd(10)} sol=${t.amountSol ?? "-"} ${t.dryRun ? "DRY" : "LIVE"}${pnl} ${link}`
      );
    }
  });

/**
 * Thin stubs — polished TUI/web live under src/ui + public (sibling agent).
 * Prefer dynamic import so core builds even if UI files are still landing.
 */
program
  .command("dashboard")
  .description("Terminal dashboard (TUI) — [b] BOT ON/OFF, [c] Techno chat, 10s refresh")
  .action(async () => {
    try {
      const mod = await import("./ui/tui.js");
      await mod.runTui();
    } catch (e) {
      console.error(chalk.red(`TUI failed: ${(e as Error).message}`));
      try {
        const snap = await buildSnapshot();
        console.log(
          JSON.stringify(
            {
              bot: snap.bot.armed ? "ON" : "OFF",
              dryRun: snap.config.dryRun,
              address: snap.wallet.address,
              balanceSol: snap.wallet.balanceSol,
              positions: snap.positions.length,
              history: snap.history.length,
            },
            null,
            2
          )
        );
      } catch {
        /* ignore */
      }
      process.exitCode = 1;
    }
  });


program
  .command("web")
  .description("Local web dashboard (Express) — BOT ON/OFF + Techno chat sidebar")
  .option("--no-open", "Do not spawn a browser window")
  .option("--port <n>", "Listen port", "8787")
  .action(async (opts: { open?: boolean; port?: string }) => {
    try {
      const mod = await import("./ui/web.js");
      await mod.runWeb({
        open: opts.open !== false,
        port: Number(opts.port) || 8787,
      });
    } catch (e) {
      console.error(chalk.red(`Web UI failed: ${(e as Error).message}`));
      console.log(chalk.dim("Fallback: GET snapshot via npm run bot -- status"));
      process.exitCode = 1;
    }
  });



program
  .command("setup")
  .description("Interactive connections wizard (RPC, Jupiter, X, xAI/Grok) — writes .env safely")
  .action(async () => {
    try {
      const mod = await import("./setup.js");
      await mod.runSetup();
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exitCode = 1;
    }
  });


const yoloCmd = program.command("yolo").description("Jupiter YOLO browser venue (brittle; DRY_RUN default)");

yoloCmd
  .command("dry-run")
  .description("Open YOLO page (if Chromium), simulate long/short, never sign")
  .option("--seconds <n>", "Session length", "90")
  .action(async (opts: { seconds?: string }) => {
    process.env.DRY_RUN = "true";
    delete process.env.YOLO_LIVE;
    const sec = Number(opts.seconds) || 90;
    try {
      const { runYoloLoop } = await import("./yolo/loop.js");
      await runYoloLoop({ durationMs: sec * 1000, forceTradeIfIdle: true });
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exitCode = 1;
    }
  });

yoloCmd
  .command("run")
  .description("YOLO loop: 30s scan LONG/SHORT/DO NOTHING + 40s max hold (respects DRY_RUN)")
  .option("--once", "Single scan then exit")
  .option("--seconds <n>", "Optional timed session")
  .action(async (opts: { once?: boolean; seconds?: string }) => {
    const cfg = loadConfig();
    if (cfg.dryRun) {
      console.log(chalk.yellow("DRY_RUN=true — YOLO actions simulated. Set DRY_RUN=false and YOLO_LIVE=true for live clicks."));
    } else if (!["1", "true", "yes", "on"].includes(String(process.env.YOLO_LIVE || "").toLowerCase())) {
      console.log(chalk.yellow("DRY_RUN=false but YOLO_LIVE not set — still simulating. Export YOLO_LIVE=true to click."));
    } else {
      console.log(chalk.red.bold("YOLO LIVE — browser will click Long/Short/Close. Tiny size only. Extreme leverage risk."));
    }
    try {
      const { runYoloLoop } = await import("./yolo/loop.js");
      await runYoloLoop({
        once: !!opts.once,
        durationMs: opts.seconds ? Number(opts.seconds) * 1000 : 0,
        forceTradeIfIdle: false,
      });
    } catch (e) {
      console.error(chalk.red((e as Error).message));
      process.exitCode = 1;
    }
  });

yoloCmd
  .command("status")
  .description("Show YOLO positions + fragility notes")
  .action(async () => {
    const { loadYoloPositions, FRAGILITY_NOTES, openYoloPositions } = await import("./yolo/index.js");
    const cfg = loadConfig();
    console.log(chalk.bold("=== YOLO status ==="));
    console.log(`Venue:       ${cfg.tradeVenue}`);
    console.log(`Dry run:     ${cfg.dryRun}`);
    console.log(`YOLO_LIVE:   ${process.env.YOLO_LIVE || "(unset)"}`);
    console.log(`Collateral:  ${cfg.yoloCollateral} (min 5 JupUSD)`);
    console.log(`Leverage:    ${cfg.yoloLeverage}x`);
    console.log(`TP / SL:     +${cfg.takeProfitPct}% / -${cfg.stopLossPct}% (collateral PnL)`);
    console.log(`Max hold:    ${cfg.maxHoldSeconds}s`);
    const open = openYoloPositions();
    console.log(chalk.bold(`\nOpen: ${open.length}`));
    for (const p of open) {
      console.log(`  ${p.side} entry=$${p.entryMarkUsd} lev=${p.leverage}x dry=${p.dryRun} id=${p.id.slice(0, 8)}…`);
    }
    const closed = loadYoloPositions().filter((p) => p.status === "closed").slice(-8);
    console.log(chalk.bold(`Recent closed: ${closed.length}`));
    for (const p of closed) {
      console.log(
        `  ${p.side} entry=$${p.entryMarkUsd} exit=$${p.exitMarkUsd ?? "?"} pnl=${p.collateralPnlPct ?? "?"}% reason=${p.closeReason}`
      );
    }
    console.log(chalk.bold("\nFragility:"));
    for (const n of FRAGILITY_NOTES) console.log(chalk.dim("  • " + n));
  });

yoloCmd
  .command("paper")
  .description("5-minute mark-proxy paper session (no browser) — npm run paper")
  .action(async () => {
    console.log(chalk.dim("Delegating to scripts/paper-yolo.ts …"));
    const { spawn } = await import("node:child_process");
    const child = spawn("node", ["--import", "tsx", "scripts/paper-yolo.ts"], {
      stdio: "inherit",
      cwd: new URL("..", import.meta.url).pathname,
      env: process.env,
    });
    await new Promise<void>((resolve, reject) => {
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("paper exit " + code))));
    });
  });


program.parseAsync(process.argv).catch((e) => {
  console.error(chalk.red(String(e)));
  process.exit(1);
});
