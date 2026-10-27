/**
 * Dry-run selector probe against jup.ag/yolo — never clicks Long/Short/Close.
 * Reports which documented selectors are visible. Safe for CI / docs refresh.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import { FRAGILITY_NOTES, SELECTORS, YOLO_URL_SOL_CLASSIC } from "./selectors.js";

export interface SelectorProbeHit {
  key: string;
  matched: boolean;
  detail: string;
}

export interface SelectorProbeReport {
  url: string;
  at: string;
  dryRun: true;
  clickedLongShortClose: false;
  playwright: boolean;
  hits: SelectorProbeHit[];
  fragilityNotes: string[];
  screenshotPath?: string;
  note: string;
}

async function loadPlaywright(): Promise<typeof import("playwright") | null> {
  try {
    return await import("playwright");
  } catch {
    return null;
  }
}

export async function probeYoloSelectors(opts?: {
  headless?: boolean;
  timeoutMs?: number;
  screenshotDir?: string;
}): Promise<SelectorProbeReport> {
  const at = new Date().toISOString();
  const screenshotDir =
    opts?.screenshotDir ?? path.join(ROOT, "data", "yolo-screenshots");
  const base: SelectorProbeReport = {
    url: YOLO_URL_SOL_CLASSIC,
    at,
    dryRun: true,
    clickedLongShortClose: false,
    playwright: false,
    hits: [],
    fragilityNotes: [...FRAGILITY_NOTES],
    note:
      "Probe only — Accept/terms and market tabs may be clicked for visibility; Long/Short/Close are NEVER clicked.",
  };

  const pw = await loadPlaywright();
  if (!pw) {
    base.note =
      "playwright not installed — documented selectors only. npm i && npx playwright install chromium";
    for (const key of Object.keys(SELECTORS)) {
      base.hits.push({
        key,
        matched: false,
        detail: "skipped (no playwright)",
      });
    }
    return base;
  }
  base.playwright = true;

  const browser = await pw.chromium.launch({ headless: opts?.headless ?? true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(YOLO_URL_SOL_CLASSIC, {
      waitUntil: "domcontentloaded",
      timeout: opts?.timeoutMs ?? 45_000,
    });
    await page.waitForTimeout(2_500);

    // Soft-dismiss seasonal overlays then terms
    for (const c of SELECTORS.dismissOverlay) {
      if ("role" in c) {
        try {
          const loc = page.getByRole(c.role, { name: c.name }).first();
          if (await loc.isVisible({ timeout: 600 }).catch(() => false)) {
            await loc.click({ timeout: 1_500 });
          }
        } catch {
          /* ignore */
        }
      }
    }

    // Soft-dismiss terms so Long/Short may render — still no trade clicks
    for (const c of SELECTORS.acceptTerms) {
      if ("role" in c) {
        try {
          const loc = page.getByRole(c.role, { name: c.name }).first();
          if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
            await loc.click({ timeout: 2_000 });
            break;
          }
        } catch {
          /* ignore */
        }
      }
    }

    const check = async (
      key: string,
      candidates: ReadonlyArray<
        { role: "button" | "tab"; name: RegExp } | { text: RegExp } | string
      >
    ): Promise<SelectorProbeHit> => {
      for (const c of candidates) {
        try {
          if (typeof c === "string") {
            const loc = page.locator(c).first();
            const n = await loc.count();
            if (n > 0) {
              const vis = await loc.isVisible().catch(() => false);
              return { key, matched: vis, detail: `css ${c} count=${n} visible=${vis}` };
            }
          } else if ("role" in c) {
            const loc = page.getByRole(c.role, { name: c.name }).first();
            const vis = await loc.isVisible({ timeout: 600 }).catch(() => false);
            if (vis) {
              return {
                key,
                matched: true,
                detail: `role=${c.role} name=${c.name}`,
              };
            }
          } else if ("text" in c) {
            const loc = page.getByText(c.text).first();
            const vis = await loc.isVisible({ timeout: 600 }).catch(() => false);
            if (vis) {
              return { key, matched: true, detail: `text=${c.text}` };
            }
          }
        } catch {
          /* next */
        }
      }
      return { key, matched: false, detail: "no candidate matched / visible" };
    };

    const keys = Object.keys(SELECTORS) as Array<keyof typeof SELECTORS>;
    for (const key of keys) {
      base.hits.push(await check(key, SELECTORS[key] as never));
    }

    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    const shot = path.join(screenshotDir, `${Date.now()}-probe.png`);
    try {
      await page.screenshot({ path: shot, fullPage: true });
      base.screenshotPath = shot;
    } catch {
      /* ignore */
    }

    const matched = base.hits.filter((h) => h.matched).length;
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const blankShell =
      matched === 0 ||
      bodyText.trim().length < 40 ||
      /captcha|checking your browser|just a moment/i.test(bodyText);
    if (blankShell) {
      base.note = `BLANK/CAPTCHA SHELL likely (matched=${matched}/${base.hits.length}, bodyChars=${bodyText.trim().length}). Re-run headed (\`npm run bot -- yolo probe --headed\`) before trusting misses. Long/Short/Close were NOT clicked.`;
    } else {
      base.note = `Probe complete: ${matched}/${base.hits.length} selectors visible. Long/Short/Close were NOT clicked. UI may be blank/captcha in headless — treat misses as fragile, not proof of absence.`;
    }
    return base;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
