/**
 * Injected Phantom-compatible Solana provider for Playwright YOLO runs.
 *
 * Security model:
 * - Secret keypair stays in Node (.wallet/, loadKeypair). NEVER written into page JS,
 *   screenshots, logs, or git.
 * - Only the public key base58 is passed into the browser init script.
 * - Signing happens via page.exposeFunction → Node; page only sees base64 txs/messages.
 *
 * Prefer this over importing into a real Phantom extension (that would paste the secret
 * into a UI the user or screenshots could see).
 */
import { Buffer } from "node:buffer";
import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { getAddress, loadKeypair } from "../wallet.js";

export interface InjectedWalletBindings {
  publicKey: string;
  /** Call after newPage / before goto. */
  attach: (page: import("playwright").Page) => Promise<void>;
}

function toB64(u8: Uint8Array): string {
  return Buffer.from(u8).toString("base64");
}

function fromB64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function signBytes(kp: Keypair, message: Uint8Array): Uint8Array {
  const seed = kp.secretKey.slice(0, 32);
  return ed25519.sign(message, seed);
}

function signTxBase64(kp: Keypair, txB64: string): string {
  const raw = Buffer.from(txB64, "base64");
  try {
    const vtx = VersionedTransaction.deserialize(raw);
    vtx.sign([kp]);
    return toB64(vtx.serialize());
  } catch {
    const tx = Transaction.from(raw);
    tx.partialSign(kp);
    return toB64(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  }
}

/**
 * Create Node↔page bindings for an injected Phantom-like wallet.
 * Does not log or return the secret.
 */
export function createInjectedWalletBindings(opts?: {
  /** When true, signTransaction / signMessage auto-approve (needed for unattended LIVE). */
  autoApprove?: boolean;
}): InjectedWalletBindings {
  const kp = loadKeypair();
  const publicKey = kp.publicKey.toBase58();
  const listed = getAddress();
  if (listed && listed !== publicKey) {
    throw new Error(
      `Wallet address mismatch: address.txt=${listed.slice(0, 8)}… keypair=${publicKey.slice(0, 8)}…`
    );
  }
  const autoApprove = opts?.autoApprove ?? true;

  return {
    publicKey,
    async attach(page) {
      await page.exposeFunction("__yoloWalletSignTx", async (txB64: string) => {
        if (!autoApprove) throw new Error("YOLO wallet auto-approve disabled — cannot sign");
        return signTxBase64(kp, txB64);
      });
      await page.exposeFunction("__yoloWalletSignAllTx", async (txsB64: string[]) => {
        if (!autoApprove) throw new Error("YOLO wallet auto-approve disabled — cannot sign");
        return txsB64.map((t) => signTxBase64(kp, t));
      });
      await page.exposeFunction("__yoloWalletSignMsg", async (msgB64: string) => {
        if (!autoApprove) throw new Error("YOLO wallet auto-approve disabled — cannot sign");
        return toB64(signBytes(kp, fromB64(msgB64)));
      });

      // Only publicKey string enters the page. Never the secret.
      // Use a plain .js source string — tsx/esbuild __name helpers break Playwright fn serialization.
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { ROOT } = await import("../config.js");
      const injectPath = path.join(ROOT, "src", "yolo", "inject-phantom-page.js");
      const injectSrc = fs.readFileSync(injectPath, "utf8");
      await page.addInitScript({ content: `(${injectSrc})(${JSON.stringify(publicKey)});` });

    },
  };
}

/** Clamp collateral to YOLO market minimum (5 JupUSD). */
export function clampYoloCollateral(n: number): number {
  if (!Number.isFinite(n) || n < 5) return 5;
  return n;
}

export function assertPublicAddressOnly(value: string): void {
  if (/^\s*\[/.test(value) || value.length > 64) {
    throw new Error("Refusing to surface a value that looks like a secret key");
  }
  new PublicKey(value);
}
