/**
 * YOLO browser driver — Playwright against jup.ag/yolo.
 *
 * DRY_RUN (default): open page, screenshot, log intended Long/Short/Close — never confirm.
 * LIVE: requires dryRun=false AND liveEnabled=true; clicks Long/Short/Close.
 *        Does NOT inject private keys — wallet must be connected in persistent profile.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ROOT } from "../config.js";
import { FRAGILITY_NOTES, SELECTORS, YOLO_URL_SOL_CLASSIC } from "./selectors.js";
import { addYoloPosition, closeYoloPosition, openYoloPositions } from "./positions-store.js";
import type {
  YoloActionResult,
  YoloDriverConfig,
  YoloOpenRequest,
  YoloPosition,
  YoloSide,
} from "./types.js";

export function defaultYoloConfig(partial?: Partial<YoloDriverConfig>): YoloDriverConfig {
  const dryRun = partial?.dryRun ?? true;
  const liveEnabled = partial?.liveEnabled ?? false;
  return {
    dryRun,
    headless: partial?.headless ?? true,
    market: partial?.market ?? "SOL",
    mode: "classic",
    collateral: partial?.collateral ?? 5, // YOLO minimum
    leverage: partial?.leverage ?? 500, // lowest offered
    url: partial?.url ?? YOLO_URL_SOL_CLASSIC,
    userDataDir: partial?.userDataDir,
    screenshotDir: partial?.screenshotDir ?? path.join(ROOT, "data", "yolo-screenshots"),
    timeoutMs: partial?.timeoutMs ?? 45_000,
    liveEnabled: dryRun ? false : liveEnabled,
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

async function fillCollateral(page: import("playwright").Page, amount: number): Promise<boolean> {
  for (const sel of SELECTORS.collateralInput) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        await loc.fill(String(amount), { timeout: 3_000 });
        return true;
      }
    } catch {
      /* next */
    }
  }
  return false;
}

export class YoloDriver {
  readonly cfg: YoloDriverConfig;
  private browser: import("playwright").Browser | import("playwright").BrowserContext | null = null;
  private page: import("playwright").Page | null = null;
  private ownsBrowser = false;

  constructor(cfg?: Partial<YoloDriverConfig>) {
    this.cfg = defaultYoloConfig(cfg);
  }

  fragilityNotes(): string[] {
    return [...FRAGILITY_NOTES];
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
      if (this.cfg.userDataDir && !this.cfg.dryRun && this.cfg.liveEnabled) {
        const ctx = await pw.chromium.launchPersistentContext(this.cfg.userDataDir, {
          headless: this.cfg.headless,
          viewport: { width: 1440, height: 900 },
        });
        this.browser = ctx;
        this.page = ctx.pages()[0] ?? (await ctx.newPage());
      } else {
        const browser = await pw.chromium.launch({ headless: this.cfg.headless });
        this.browser = browser;
        this.ownsBrowser = true;
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        this.page = await ctx.newPage();
      }
      await this.page.goto(this.cfg.url, {
        waitUntil: "domcontentloaded",
        timeout: this.cfg.timeoutMs,
      });
      // Best-effort dismiss terms
      await tryClickRole(this.page, SELECTORS.acceptTerms, 2_000);
      const screenshotPath = await shot(this.page, this.cfg.screenshotDir, "navigate");
      return {
        ok: true,
        dryRun: this.cfg.dryRun,
        action: "navigate",
        message: `Opened ${this.cfg.url} headless=${this.cfg.headless} dryRun=${this.cfg.dryRun}`,
        screenshotPath,
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

  async openPosition(req: YoloOpenRequest): Promise<YoloActionResult> {
    const side: YoloSide = req.side;
    const collateral = req.collateral ?? this.cfg.collateral;
    const leverage = req.leverage ?? this.cfg.leverage;
    const id = randomUUID();

    // Always record a tracked position for off-page TP/SL/max-hold
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
        // Hover/focus intended button but DO NOT click confirm path in dry-run
        const btns = side === "LONG" ? SELECTORS.longButton : SELECTORS.shortButton;
        await tryClickRole(this.page, SELECTORS.marketSol, 2_000).catch(() => false);
        await fillCollateral(this.page, collateral).catch(() => false);
        // Locate button visibility for the screenshot log — click only if we want prep,
        // but we skip the actual Long/Short click in dry-run to avoid wallet popups.
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
      await tryClickRole(page, SELECTORS.marketSol, 3_000);
      await fillCollateral(page, collateral);
      const btns = side === "LONG" ? SELECTORS.longButton : SELECTORS.shortButton;
      const clicked = await tryClickRole(page, btns, 5_000);
      if (!clicked) {
        return {
          ok: false,
          dryRun: false,
          action: "open",
          side,
          message: `LIVE: could not find ${side} button — UI selectors likely stale`,
          error: "selector_miss",
          screenshotPath: await shot(page, this.cfg.screenshotDir, `fail-${side.toLowerCase()}`),
        };
      }
      // Wallet approve is external — wait briefly for Positions row
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
        message: `LIVE clicked ${side} — confirm wallet popup if shown; 15s close lockout applies`,
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
      // Caller (monitor) sets reason/pnl via closeYoloPosition — here just UI sim
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
      // Respect 15s YOLO lockout
      const age = Date.now() - Date.parse(target.openedAt);
      if (age < 15_000) {
        await page.waitForTimeout(15_000 - age + 500);
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

  /** Finalize store close after driver close / monitor decision. */
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
  }
}
