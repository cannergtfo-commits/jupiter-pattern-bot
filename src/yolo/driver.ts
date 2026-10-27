/**
 * YOLO browser driver — Playwright against jup.ag/yolo.
 *
 * DRY_RUN (default): open page, screenshot, log intended Long/Short/Close — never confirm.
 * LIVE: requires dryRun=false AND liveEnabled=true; clicks Long/Short/Close.
 *
 * Wallet Connect (preferred for box-run):
 *   YOLO_INJECT_WALLET=true (default) injects a Phantom-compatible provider.
 *   Secret stays in Node via exposeFunction — never written into page JS / screenshots.
 * Fallback: persistent Chromium profile with a manually connected extension
 *   (YOLO_USER_DATA_DIR) — do NOT paste secrets into chat for that path.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT } from "../config.js";
import { YOLO_CLOSE_LOCKOUT_MS, YOLO_DEFAULT_COLLATERAL, YOLO_DEFAULT_LEVERAGE } from "./constants.js";
import { FRAGILITY_NOTES, SELECTORS, YOLO_URL_SOL_CLASSIC } from "./selectors.js";
import { addYoloPosition, closeYoloPosition, openYoloPositions } from "./positions-store.js";
import {
  clampYoloCollateral,
  createInjectedWalletBindings,
  type InjectedWalletBindings,
} from "./injected-wallet.js";
import type {
  YoloActionResult,
  YoloDriverConfig,
  YoloOpenRequest,
  YoloPosition,
  YoloSide,
} from "./types.js";

function envFlag(name: string, defaultTrue = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultTrue;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

export function defaultYoloConfig(partial?: Partial<YoloDriverConfig>): YoloDriverConfig {
  const dryRun = partial?.dryRun ?? true;
  const liveEnabled = partial?.liveEnabled ?? false;
  const injectWallet = partial?.injectWallet ?? envFlag("YOLO_INJECT_WALLET", true);
  return {
    dryRun,
    headless: partial?.headless ?? true,
    market: partial?.market ?? "SOL",
    mode: "classic",
    collateral: clampYoloCollateral(partial?.collateral ?? YOLO_DEFAULT_COLLATERAL),
    leverage: partial?.leverage ?? YOLO_DEFAULT_LEVERAGE,
    url: partial?.url ?? YOLO_URL_SOL_CLASSIC,
    userDataDir: partial?.userDataDir,
    screenshotDir: partial?.screenshotDir ?? path.join(ROOT, "data", "yolo-screenshots"),
    timeoutMs: partial?.timeoutMs ?? 45_000,
    liveEnabled: dryRun ? false : liveEnabled,
    injectWallet,
    autoApproveWallet: partial?.autoApproveWallet ?? envFlag("YOLO_AUTO_APPROVE", true),
  };
}

function ensureDir(d: string): void {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

async function shot(
  page: { screenshot: (o: { path: string; fullPage?: boolean }) => Promise<Buffer> } | null,
  dir: string,
  label: string
): Promise<string | undefined> {
  if (!page) return undefined;
  ensureDir(dir);
  const file = path.join(dir, `${Date.now()}-${label}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return undefined;
  }
}

type PW = typeof import("playwright");

async function loadPlaywright(): Promise<PW | null> {
  try {
    return (await import("playwright")) as PW;
  } catch {
    return null;
  }
}

async function tryClickRole(
  page: import("playwright").Page,
  candidates: ReadonlyArray<{ role: "button" | "tab"; name: RegExp } | { text: RegExp } | string>,
  timeout = 3_000
): Promise<boolean> {
  for (const c of candidates) {
    try {
      if (typeof c === "string") {
        const loc = page.locator(c).first();
        if (await loc.count()) {
          await loc.click({ timeout });
          return true;
        }
      } else if ("role" in c) {
        const loc = page.getByRole(c.role, { name: c.name }).first();
        if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
          await loc.click({ timeout });
          return true;
        }
      } else if ("text" in c) {
        const loc = page.getByText(c.text).first();
        if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
          await loc.click({ timeout });
          return true;
        }
      }
    } catch {
      /* try next */
    }
  }
  return false;
}


async function clickPhantomInModal(page: import("playwright").Page): Promise<boolean> {
  const candidates = [
    page.getByRole("button", { name: /continue\s*to\s*phantom/i }),
    page.getByText(/continue\s*to\s*phantom/i),
    page.locator('[data-testid*="phantom" i]'),
    page.getByRole("button", { name: /^phantom$/i }),
    page.locator('button:has-text("Phantom")'),
    page.locator('div[role="button"]:has-text("Phantom")'),
    page.locator('li:has-text("Phantom")'),
    page.getByRole("button", { name: /phantom/i }),
    page.getByText(/^phantom$/i),
  ];
  for (const loc of candidates) {
    try {
      const el = loc.first();
      if (await el.isVisible({ timeout: 700 }).catch(() => false)) {
        await el.scrollIntoViewIfNeeded().catch(() => undefined);
        await el.click({ timeout: 3_000, force: true });
        return true;
      }
    } catch {
      /* next */
    }
  }
  return false;
}

async function fillCollateral(page: import("playwright").Page, amount: number): Promise<boolean> {
  const clamped = clampYoloCollateral(amount);
  for (const sel of SELECTORS.collateralInput) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        await loc.fill(String(clamped), { timeout: 3_000 });
        return true;
      }
    } catch {
      /* next */
    }
  }
  return false;
}

async function isConnectVisible(page: import("playwright").Page): Promise<boolean> {
  try {
    if (await page.getByRole("button", { name: /^connect$/i }).first().isVisible({ timeout: 600 })) {
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    return await page.getByRole("button", { name: /connect\s*wallet/i }).first().isVisible({ timeout: 400 });
  } catch {
    return false;
  }
}

async function isLongShortVisible(page: import("playwright").Page): Promise<boolean> {
  for (const c of [...SELECTORS.longButton, ...SELECTORS.shortButton]) {
    if (typeof c !== "string" && "role" in c) {
      try {
        if (await page.getByRole(c.role, { name: c.name }).first().isVisible({ timeout: 500 })) {
          return true;
        }
      } catch {
        /* next */
      }
    }
  }
  return false;
}

export class YoloDriver {
  readonly cfg: YoloDriverConfig;
  private browser: import("playwright").Browser | import("playwright").BrowserContext | null = null;
  private page: import("playwright").Page | null = null;
  private ownsBrowser = false;
  private injected: InjectedWalletBindings | null = null;
  private connectedPublicKey: string | undefined;

  constructor(cfg?: Partial<YoloDriverConfig>) {
    this.cfg = defaultYoloConfig(cfg);
  }

  fragilityNotes(): string[] {
    return [...FRAGILITY_NOTES];
  }

  getPublicKey(): string | undefined {
    return this.connectedPublicKey ?? this.injected?.publicKey;
  }

  async openBrowser(): Promise<YoloActionResult> {
    ensureDir(this.cfg.screenshotDir);
    const pw = await loadPlaywright();
    if (!pw) {
      return {
        ok: true,
        dryRun: true,
        action: "noop",
        message: "playwright not installed — mock mode (no browser). npm i playwright && npx playwright install chromium",
      };
    }
    try {
      if (this.cfg.injectWallet) {
        this.injected = createInjectedWalletBindings({ autoApprove: this.cfg.autoApproveWallet });
        this.connectedPublicKey = this.injected.publicKey;
      }

      const launchArgs = ["--disable-blink-features=AutomationControlled"];
      if (this.cfg.userDataDir) {
        const ctx = await pw.chromium.launchPersistentContext(this.cfg.userDataDir, {
          headless: this.cfg.headless,
          viewport: { width: 1440, height: 900 },
          args: launchArgs,
        });
        this.browser = ctx;
        this.page = ctx.pages()[0] ?? (await ctx.newPage());
        if (this.injected) await this.injected.attach(this.page);
      } else {
        const browser = await pw.chromium.launch({ headless: this.cfg.headless, args: launchArgs });
        this.browser = browser;
        this.ownsBrowser = true;
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        this.page = await ctx.newPage();
        if (this.injected) await this.injected.attach(this.page);
      }

      await this.page.goto(this.cfg.url, {
        waitUntil: "domcontentloaded",
        timeout: this.cfg.timeoutMs,
      });
      // Let React hydrate (headed paints late; headless often stays black)
      await this.page.waitForTimeout(2_500);
      await tryClickRole(this.page, SELECTORS.dismissOverlay, 2_000).catch(() => false);
      await tryClickRole(this.page, SELECTORS.acceptTerms, 2_000);
      // Second pass: seasonal promo / "Maybe later" after first paint
      await tryClickRole(this.page, SELECTORS.dismissOverlay, 1_500).catch(() => false);
      await this.page.waitForTimeout(1_000);

      const screenshotPath = await shot(this.page, this.cfg.screenshotDir, "navigate");
      const pkNote = this.injected ? ` injectWallet pk=${this.injected.publicKey}` : "";
      return {
        ok: true,
        dryRun: this.cfg.dryRun,
        action: "navigate",
        message: `Opened ${this.cfg.url} headless=${this.cfg.headless} dryRun=${this.cfg.dryRun}${pkNote}`,
        screenshotPath,
        publicKey: this.injected?.publicKey,
      };
    } catch (e) {
      return {
        ok: false,
        dryRun: this.cfg.dryRun,
        action: "navigate",
        message: "Failed to open YOLO page",
        error: (e as Error).message,
      };
    }
  }

  /**
   * Click Connect → Phantom (injected). Safe in dry-run (connect only, no Long/Short).
   * Secret never enters the page.
   */
  async connectWallet(): Promise<YoloActionResult> {
    if (!this.page) {
      const nav = await this.openBrowser();
      if (!nav.ok) return { ...nav, action: "connect" };
    }
    const page = this.page!;
    try {
      await tryClickRole(page, SELECTORS.dismissOverlay, 1_000).catch(() => false);

      // Already connected?
      if (!(await isConnectVisible(page)) && (await isLongShortVisible(page))) {
        const screenshotPath = await shot(page, this.cfg.screenshotDir, "already-connected");
        return {
          ok: true,
          dryRun: this.cfg.dryRun,
          action: "connect",
          message: `Wallet already connected (Long/Short visible)${this.injected ? ` pk=${this.injected.publicKey}` : ""}`,
          screenshotPath,
          publicKey: this.injected?.publicKey,
        };
      }

      if (!this.injected && this.cfg.injectWallet) {
        return {
          ok: false,
          dryRun: this.cfg.dryRun,
          action: "connect",
          message: "injectWallet enabled but bindings missing — reopen browser",
          error: "inject_missing",
        };
      }

      // Prefer landing CTA "Continue to Phantom" when present (skips wallet modal)
      const continued = await tryClickRole(page, SELECTORS.continueToPhantom, 2_500);
      if (continued) {
        console.log("[yolo] clicked Continue to Phantom");
        await page.waitForTimeout(1_000);
      }

      const clickedConnect = continued
        ? true
        : await tryClickRole(page, SELECTORS.connectWallet, 5_000);
      if (!clickedConnect) {
        const screenshotPath = await shot(page, this.cfg.screenshotDir, "connect-miss");
        // Maybe already past connect
        if (await isLongShortVisible(page)) {
          return {
            ok: true,
            dryRun: this.cfg.dryRun,
            action: "connect",
            message: "Connect button missing but Long/Short visible — treating as connected",
            screenshotPath,
            publicKey: this.injected?.publicKey,
          };
        }
        return {
          ok: false,
          dryRun: this.cfg.dryRun,
          action: "connect",
          message: "Connect button not found (blank/captcha shell? try headed)",
          error: "connect_miss",
          screenshotPath,
        };
      }

      // Modal often shows Jupiter Wallet / Mobile first — expand list, then Phantom
      await page.waitForTimeout(800);
      await tryClickRole(page, SELECTORS.viewMoreWallets, 3_000);
      await page.waitForTimeout(500);
      let picked = await clickPhantomInModal(page);
      if (!picked) {
        await tryClickRole(page, SELECTORS.viewMoreWallets, 2_000);
        await page.waitForTimeout(400);
        picked = await clickPhantomInModal(page);
      }
      if (!picked) {
        await tryClickRole(
          page,
          [
            { role: "button", name: /browser\s*wallet/i },
            { text: /injected/i },
          ],
          2_000
        );
      }
      console.log(`[yolo] phantom tile clicked=${picked}`);
      // Landing CTA sometimes shows "Continue to Phantom" outside the modal
      await tryClickRole(page, SELECTORS.continueToPhantom, 2_000);


      // Ensure provider.connect ran (sites call it; also call directly as fallback)
      if (this.injected) {
        const bridge = await page.evaluate(async () => {
          const w = window as unknown as {
            solana?: {
              isPhantom?: boolean;
              connect: () => Promise<unknown>;
              publicKey?: { toString(): string } | null;
            };
            phantom?: { solana?: { isPhantom?: boolean; connect: () => Promise<unknown> } };
          };
          const has = {
            solana: !!w.solana,
            phantom: !!w.phantom?.solana,
            isPhantom: !!(w.solana?.isPhantom || w.phantom?.solana?.isPhantom),
          };
          try {
            await w.phantom?.solana?.connect();
          } catch {
            /* ignore */
          }
          try {
            await w.solana?.connect();
          } catch {
            /* ignore */
          }
          return {
            ...has,
            pk: w.solana?.publicKey ? w.solana.publicKey.toString() : null,
          };
        });
        console.log(`[yolo] injected bridge`, bridge);
      }

      // Poll for ticket (Long/Short) — Jupiter React state lags after wallet-standard connect
      let longShort = false;
      let connectStill = true;
      let modalOpen = true;
      let addrChip = false;
      let bridgePk: string | null = null;
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(700);
        await tryClickRole(page, SELECTORS.acceptTerms, 700).catch(() => false);
        await tryClickRole(page, SELECTORS.dismissOverlay, 500).catch(() => false);
        await tryClickRole(page, SELECTORS.continueToPhantom, 500).catch(() => false);
        if (i === 2 || i === 5 || i === 8) {
          await clickPhantomInModal(page).catch(() => false);
          await page.keyboard.press("Escape").catch(() => undefined);
          await page
            .locator('button[aria-label*="close" i], button:has-text("×")')
            .first()
            .click({ timeout: 600 })
            .catch(() => undefined);
        }
        bridgePk = await page.evaluate(() => {
          const w = window as unknown as { solana?: { publicKey?: { toString(): string } | null } };
          return w.solana?.publicKey ? w.solana.publicKey.toString() : null;
        });
        longShort = await isLongShortVisible(page);
        connectStill = await isConnectVisible(page);
        modalOpen = await page
          .getByText(/view\s*more\s*wallets|view\s*less\s*wallets|jupiter\s*mobile|get\s*jupiter\s*wallet/i)
          .first()
          .isVisible({ timeout: 300 })
          .catch(() => false);
        addrChip = this.injected
          ? await page
              .getByText(new RegExp(this.injected.publicKey.slice(0, 4), "i"))
              .first()
              .isVisible({ timeout: 300 })
              .catch(() => false)
          : false;
        if (longShort && !connectStill) break;
        if (addrChip && !modalOpen && !connectStill) break;
      }
      const connected = (longShort || addrChip) && !connectStill;
      console.log(
        `[yolo] connect check longShort=${longShort} connectStill=${connectStill} modalOpen=${modalOpen} addrChip=${addrChip} bridgePk=${!!bridgePk}`
      );

      const screenshotPath = await shot(page, this.cfg.screenshotDir, connected ? "connected" : "connect-fail");
      if (!connected) {
        return {
          ok: false,
          dryRun: this.cfg.dryRun,
          action: "connect",
          message:
            "Connect clicked but wallet still not active — Jupiter modal may need headed human, or captcha blocked page",
          error: "connect_incomplete",
          screenshotPath,
          publicKey: this.injected?.publicKey,
        };
      }

      this.connectedPublicKey = this.injected?.publicKey;
      return {
        ok: true,
        dryRun: this.cfg.dryRun,
        action: "connect",
        message: `Connected via injected Phantom provider pk=${this.injected?.publicKey ?? "(extension)"}`,
        screenshotPath,
        publicKey: this.injected?.publicKey,
      };
    } catch (e) {
      return {
        ok: false,
        dryRun: this.cfg.dryRun,
        action: "connect",
        message: "connectWallet failed",
        error: (e as Error).message,
        publicKey: this.injected?.publicKey,
      };
    }
  }

  async openPosition(req: YoloOpenRequest): Promise<YoloActionResult> {
    const side: YoloSide = req.side;
    const collateral = clampYoloCollateral(req.collateral ?? this.cfg.collateral);
    const leverage = req.leverage ?? this.cfg.leverage;
    const id = randomUUID();

    const pos: YoloPosition = {
      id,
      side,
      market: req.market ?? this.cfg.market,
      entryMarkUsd: req.entryMarkUsd,
      collateral,
      leverage,
      openedAt: new Date().toISOString(),
      status: "open",
      dryRun: this.cfg.dryRun || !this.cfg.liveEnabled,
      note: req.note,
    };

    if (this.cfg.dryRun || !this.cfg.liveEnabled) {
      let screenshotPath: string | undefined;
      if (this.page) {
        const btns = side === "LONG" ? SELECTORS.longButton : SELECTORS.shortButton;
        await tryClickRole(this.page, SELECTORS.marketSol, 2_000).catch(() => false);
        await fillCollateral(this.page, collateral).catch(() => false);
        for (const c of btns) {
          if (typeof c !== "string" && "role" in c) {
            try {
              await this.page.getByRole(c.role, { name: c.name }).first().scrollIntoViewIfNeeded();
            } catch {
              /* ignore */
            }
          }
        }
        screenshotPath = await shot(this.page, this.cfg.screenshotDir, `dry-${side.toLowerCase()}`);
      }
      addYoloPosition(pos);
      return {
        ok: true,
        dryRun: true,
        action: "open",
        side,
        positionId: id,
        screenshotPath,
        message: `DRY_RUN simulate OPEN ${side} collateral=${collateral} lev=${leverage}x entryMark=$${req.entryMarkUsd} (no wallet sign)`,
      };
    }

    // LIVE path — brittle
    if (!this.page) {
      const nav = await this.openBrowser();
      if (!nav.ok) return { ...nav, action: "open", side };
    }
    try {
      const page = this.page!;
      // Ensure connected before Long/Short
      if (await isConnectVisible(page)) {
        const conn = await this.connectWallet();
        if (!conn.ok) {
          return { ...conn, action: "open", side };
        }
      }
      await tryClickRole(page, SELECTORS.marketSol, 3_000);
      await fillCollateral(page, collateral);
      if (leverage <= 500) {
        for (let i = 0; i < 8; i++) {
          const hit = await tryClickRole(page, SELECTORS.leverageMinus, 800);
          if (!hit) break;
        }
      }
      const btns = side === "LONG" ? SELECTORS.longButton : SELECTORS.shortButton;
      const clicked = await tryClickRole(page, btns, 5_000);
      if (!clicked) {
        const connectVisible = await isConnectVisible(page);
        const shotPath = await shot(page, this.cfg.screenshotDir, `fail-${side.toLowerCase()}`);
        if (connectVisible) {
          return {
            ok: false,
            dryRun: false,
            action: "open",
            side,
            message:
              "LIVE: wallet not connected — UI shows Connect. Run `npm run bot -- yolo connect` with YOLO_INJECT_WALLET=true (default).",
            error: "wallet_not_connected",
            screenshotPath: shotPath,
          };
        }
        return {
          ok: false,
          dryRun: false,
          action: "open",
          side,
          message: `LIVE: could not find ${side} button — UI selectors likely stale`,
          error: "selector_miss",
          screenshotPath: shotPath,
        };
      }
      await page.waitForTimeout(3_000);
      const screenshotPath = await shot(page, this.cfg.screenshotDir, `live-${side.toLowerCase()}`);
      pos.dryRun = false;
      addYoloPosition(pos);
      return {
        ok: true,
        dryRun: false,
        action: "open",
        side,
        positionId: id,
        screenshotPath,
        message: `LIVE clicked ${side} collateral=${collateral} — injected wallet auto-approves sign; 15s close lockout applies`,
      };
    } catch (e) {
      return {
        ok: false,
        dryRun: false,
        action: "open",
        side,
        message: "LIVE open failed",
        error: (e as Error).message,
      };
    }
  }

  async closePosition(positionId?: string): Promise<YoloActionResult> {
    const opens = openYoloPositions();
    const target = positionId ? opens.find((p) => p.id === positionId) : opens[0];
    if (!target) {
      return {
        ok: false,
        dryRun: this.cfg.dryRun,
        action: "close",
        message: "No open YOLO position to close",
        error: "none_open",
      };
    }

    if (this.cfg.dryRun || !this.cfg.liveEnabled || target.dryRun) {
      const screenshotPath = this.page
        ? await shot(this.page, this.cfg.screenshotDir, "dry-close")
        : undefined;
      return {
        ok: true,
        dryRun: true,
        action: "close",
        side: target.side,
        positionId: target.id,
        screenshotPath,
        message: `DRY_RUN simulate CLOSE ${target.side} id=${target.id.slice(0, 8)}…`,
      };
    }

    if (!this.page) {
      const nav = await this.openBrowser();
      if (!nav.ok) return { ...nav, action: "close" };
    }
    try {
      const page = this.page!;
      const age = Date.now() - Date.parse(target.openedAt);
      if (age < YOLO_CLOSE_LOCKOUT_MS) {
        await page.waitForTimeout(YOLO_CLOSE_LOCKOUT_MS - age + 500);
      }
      await tryClickRole(page, SELECTORS.positionsTab, 2_000);
      const clicked = await tryClickRole(page, SELECTORS.closePosition, 5_000);
      const screenshotPath = await shot(page, this.cfg.screenshotDir, "live-close");
      if (!clicked) {
        return {
          ok: false,
          dryRun: false,
          action: "close",
          positionId: target.id,
          screenshotPath,
          message: "LIVE: Close button not found (maybe still in 15s lockout or UI change)",
          error: "selector_miss",
        };
      }
      return {
        ok: true,
        dryRun: false,
        action: "close",
        side: target.side,
        positionId: target.id,
        screenshotPath,
        message: `LIVE clicked Close for ${target.side}`,
      };
    } catch (e) {
      return {
        ok: false,
        dryRun: false,
        action: "close",
        positionId: target.id,
        message: "LIVE close failed",
        error: (e as Error).message,
      };
    }
  }

  finalizeClose(
    id: string,
    reason: NonNullable<YoloPosition["closeReason"]>,
    exitMark: number,
    pnlPct: number
  ): void {
    closeYoloPosition(id, reason, exitMark, pnlPct);
  }

  async close(): Promise<void> {
    try {
      if (this.page) await this.page.close().catch(() => undefined);
    } catch {
      /* ignore */
    }
    try {
      if (this.browser) {
        if (this.ownsBrowser && "close" in this.browser) await this.browser.close();
        else if ("close" in this.browser) await this.browser.close();
      }
    } catch {
      /* ignore */
    }
    this.page = null;
    this.browser = null;
    this.injected = null;
  }
}
