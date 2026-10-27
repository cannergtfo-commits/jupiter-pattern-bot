#!/usr/bin/env node
/**
 * First-run wallet init. Creates .wallet/ (0600 keypair or encrypted keystore).
 * Prints PUBLIC address only. Never prints the secret.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function main() {
  const envPath = path.join(ROOT, ".env");
  const example = path.join(ROOT, ".env.example");
  if (!fs.existsSync(envPath) && fs.existsSync(example)) {
    fs.copyFileSync(example, envPath);
    console.log("Created .env from .env.example (DRY_RUN=true, TP=50, SL=20, maxHold=40s)");
  }

  const { createWallet, walletExists, getAddress, safeWalletInfo } = await import("../src/wallet.js");
  if (walletExists()) {
    const info = safeWalletInfo();
    console.log("Wallet already exists.");
    console.log("Public address:", getAddress());
    console.log(info.encrypted ? "Mode: encrypted keystore" : "Mode: keypair.json mode 0600");
    console.log("Secret stays under .wallet/ (gitignored). Never paste it into chat.");
    return;
  }
  const { publicKey, path: kpPath, encrypted } = createWallet();
  console.log(encrypted ? "✓ Encrypted keystore created at" : "✓ Wallet created at", kpPath);
  console.log("Public address:", publicKey);
  console.log("");
  console.log("Fund this PUBLIC address with SOL (and JupUSD if you later trade YOLO in a browser).");
  console.log("DRY_RUN stays true until you edit .env.");
  console.log("Optional: set WALLET_PASSWORD in .env then run: npm run bot -- wallet encrypt");
  console.log("Never commit .wallet/ or paste the secret into chat.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
