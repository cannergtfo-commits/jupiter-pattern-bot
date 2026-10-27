import { chromium } from "playwright";
import { createInjectedWalletBindings } from "../src/yolo/injected-wallet.js";
import { YOLO_URL_SOL_CLASSIC } from "../src/yolo/selectors.js";

async function main() {
  const bindings = createInjectedWalletBindings({ autoApprove: true });
  console.log("public", bindings.publicKey);
  const browser = await chromium.launch({ headless: false, args: ["--disable-blink-features=AutomationControlled"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  page.on("console", (m) => {
    const t = m.text();
    if (/yolo|phantom|solana|error|Error/i.test(t)) console.log("CONSOLE", t.slice(0, 200));
  });
  await bindings.attach(page);
  // Verify init ran on a blank page first
  await page.goto("about:blank");
  const blank = await page.evaluate(() => {
    const w = window as unknown as { solana?: unknown; phantom?: unknown };
    return { solana: !!w.solana, phantom: !!w.phantom };
  });
  console.log("about:blank inject", blank);

  await page.goto(YOLO_URL_SOL_CLASSIC, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);
  const after = await page.evaluate(() => {
    const w = window as unknown as {
      solana?: { isPhantom?: boolean; isYoloBot?: boolean };
      phantom?: { solana?: { isPhantom?: boolean; isYoloBot?: boolean } };
    };
    return {
      solana: !!w.solana,
      phantom: !!w.phantom?.solana,
      isPhantom: !!(w.solana?.isPhantom || w.phantom?.solana?.isPhantom),
      isYoloBot: !!(w.solana?.isYoloBot || w.phantom?.solana?.isYoloBot),
      keys: Object.keys(window).filter((k) => /solana|phantom|yolo/i.test(k)),
    };
  });
  console.log("yolo page inject", after);
  // Re-attach provider manually if wiped
  if (!after.solana) {
    console.log("re-injecting via evaluate...");
    await page.evaluate(async (pubkey) => {
      // minimal marker
      (window as unknown as { __yoloProbe?: string }).__yoloProbe = pubkey;
    }, bindings.publicKey);
    const probe = await page.evaluate(() => (window as unknown as { __yoloProbe?: string }).__yoloProbe);
    console.log("evaluate works, probe pk prefix", probe?.slice(0, 8));
  }
  await browser.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
