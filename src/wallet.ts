import fs from "node:fs";
import crypto from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  KEYPAIR_PATH,
  KEYSTORE_PATH,
  ADDRESS_PATH,
  WALLET_DIR,
  loadConfig,
} from "./config.js";
import { addTx } from "./history.js";

const KEYSTORE_VERSION = 1;

interface KeystoreFile {
  version: number;
  publicKey: string;
  kdf: "scrypt";
  salt: string; // base64
  iv: string; // base64
  tag: string; // base64
  ciphertext: string; // base64 — encrypted 64-byte secret key
}

function ensureWalletDir(): void {
  if (!fs.existsSync(WALLET_DIR)) {
    fs.mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
  }
  try {
    fs.chmodSync(WALLET_DIR, 0o700);
  } catch {
    /* best-effort on some FS */
  }
}

function writePublicAddress(pubkey: string): void {
  fs.writeFileSync(ADDRESS_PATH, pubkey + "\n", { encoding: "utf8", mode: 0o644 });
  try {
    fs.chmodSync(ADDRESS_PATH, 0o644);
  } catch {
    /* best-effort */
  }
}

function writeSecretFile(path: string, contents: string, mode = 0o600): void {
  fs.writeFileSync(path, contents, { encoding: "utf8", mode });
  try {
    fs.chmodSync(path, mode);
  } catch {
    /* best-effort */
  }
}

function resolvePassword(explicit?: string): string | undefined {
  const p = (explicit ?? process.env.WALLET_PASSWORD ?? "").trim();
  return p.length > 0 ? p : undefined;
}

function encryptSecretKey(secretKey: Uint8Array, password: string): KeystoreFile {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(secretKey)), cipher.final()]);
  const tag = cipher.getAuthTag();
  const kp = Keypair.fromSecretKey(secretKey);
  return {
    version: KEYSTORE_VERSION,
    publicKey: kp.publicKey.toBase58(),
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptKeystore(store: KeystoreFile, password: string): Keypair {
  if (store.version !== KEYSTORE_VERSION || store.kdf !== "scrypt") {
    throw new Error("Unsupported keystore format");
  }
  const salt = Buffer.from(store.salt, "base64");
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const iv = Buffer.from(store.iv, "base64");
  const tag = Buffer.from(store.tag, "base64");
  const ciphertext = Buffer.from(store.ciphertext, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Wrong WALLET_PASSWORD or corrupt keystore — cannot unlock wallet");
  }
  if (plain.length < 64) throw new Error("Invalid decrypted key length");
  return Keypair.fromSecretKey(Uint8Array.from(plain.subarray(0, 64)));
}

export function walletExists(): boolean {
  return fs.existsSync(KEYSTORE_PATH) || fs.existsSync(KEYPAIR_PATH);
}

/**
 * Create a new local wallet.
 * - If password / WALLET_PASSWORD is set → AES-256-GCM keystore at .wallet/keystore.json (0600)
 * - Else → Solana JSON secret array at .wallet/keypair.json (0600)
 * Always writes .wallet/address.txt with the public key only. Never prints the secret.
 */
export function createWallet(opts?: { password?: string }): {
  publicKey: string;
  path: string;
  encrypted: boolean;
} {
  ensureWalletDir();
  if (walletExists()) {
    throw new Error(
      `Wallet already exists under ${WALLET_DIR}. Delete keystore/keypair manually if you want a new one.`
    );
  }
  const kp = Keypair.generate();
  const password = resolvePassword(opts?.password);
  let path: string;
  let encrypted: boolean;
  if (password) {
    const store = encryptSecretKey(kp.secretKey, password);
    path = KEYSTORE_PATH;
    writeSecretFile(path, JSON.stringify(store, null, 2) + "\n");
    encrypted = true;
  } else {
    path = KEYPAIR_PATH;
    writeSecretFile(path, JSON.stringify(Array.from(kp.secretKey)));
    encrypted = false;
  }
  writePublicAddress(kp.publicKey.toBase58());
  return { publicKey: kp.publicKey.toBase58(), path, encrypted };
}

/** Upgrade plaintext keypair.json → encrypted keystore (deletes plaintext after success). */
export function encryptExistingWallet(password: string): { publicKey: string; path: string } {
  const pwd = resolvePassword(password);
  if (!pwd) throw new Error("Password required to encrypt wallet");
  if (fs.existsSync(KEYSTORE_PATH)) {
    throw new Error("Encrypted keystore already exists");
  }
  if (!fs.existsSync(KEYPAIR_PATH)) {
    throw new Error("No plaintext keypair.json to encrypt");
  }
  const kp = loadKeypair();
  const store = encryptSecretKey(kp.secretKey, pwd);
  writeSecretFile(KEYSTORE_PATH, JSON.stringify(store, null, 2) + "\n");
  writePublicAddress(kp.publicKey.toBase58());
  try {
    fs.unlinkSync(KEYPAIR_PATH);
  } catch {
    /* leave plaintext if unlink fails — user can delete */
  }
  return { publicKey: kp.publicKey.toBase58(), path: KEYSTORE_PATH };
}

export function loadKeypair(): Keypair {
  if (fs.existsSync(KEYSTORE_PATH)) {
    const password = resolvePassword();
    if (!password) {
      throw new Error(
        "Encrypted keystore found — set WALLET_PASSWORD in .env (gitignored) to unlock. Never put the password in chat."
      );
    }
    const store = JSON.parse(fs.readFileSync(KEYSTORE_PATH, "utf8")) as KeystoreFile;
    return decryptKeystore(store, password);
  }
  if (!fs.existsSync(KEYPAIR_PATH)) {
    throw new Error("No wallet found. Run: npm run init-wallet");
  }
  const raw = fs.readFileSync(KEYPAIR_PATH, "utf8");
  const arr = JSON.parse(raw) as number[];
  if (!Array.isArray(arr) || arr.length < 64) {
    throw new Error("Invalid keypair file format");
  }
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

export function getAddress(): string {
  if (fs.existsSync(ADDRESS_PATH)) {
    const a = fs.readFileSync(ADDRESS_PATH, "utf8").trim();
    if (a) return a;
  }
  if (fs.existsSync(KEYSTORE_PATH)) {
    try {
      const store = JSON.parse(fs.readFileSync(KEYSTORE_PATH, "utf8")) as KeystoreFile;
      if (store.publicKey) return store.publicKey;
    } catch {
      /* fall through */
    }
  }
  return loadKeypair().publicKey.toBase58();
}

export function getConnection(): Connection {
  const cfg = loadConfig();
  return new Connection(cfg.rpcUrl, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
  });
}

export async function getBalanceSol(): Promise<number> {
  const conn = getConnection();
  const kp = loadKeypair();
  const lamports = await conn.getBalance(kp.publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

export function validatePubkey(dest: string): PublicKey {
  try {
    return new PublicKey(dest);
  } catch {
    throw new Error(`Invalid destination pubkey: ${dest}`);
  }
}

/**
 * Withdraw SOL to an external address.
 * Caller must pass confirm=true after showing dest+amount to the user.
 * Never logs the secret key.
 */
export async function withdrawSol(
  to: string,
  amountSol: number,
  opts?: { confirm?: boolean }
): Promise<string> {
  if (!opts?.confirm) {
    throw new Error(
      "Refusing withdraw without --yes / confirm. Re-run with --yes after checking destination and amount."
    );
  }
  if (!(amountSol > 0) || !Number.isFinite(amountSol)) {
    throw new Error("Amount must be a positive number");
  }
  const dest = validatePubkey(to);
  const cfg = loadConfig();
  const kp = loadKeypair();
  if (dest.equals(kp.publicKey)) {
    throw new Error("Cannot withdraw to the same wallet");
  }
  const conn = getConnection();
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
  if (cfg.dryRun) {
    addTx({
      kind: "withdraw",
      amountSol,
      destination: dest.toBase58(),
      dryRun: true,
      note: "DRY_RUN withdraw",
    });
    return `DRY_RUN: would withdraw ${amountSol} SOL to ${dest.toBase58()}`;
  }
  const balance = await conn.getBalance(kp.publicKey);
  const feeReserve = 5000;
  if (lamports + feeReserve > balance) {
    throw new Error(
      `Insufficient balance. Have ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL, need ~${amountSol} + fees`
    );
  }
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: kp.publicKey,
      toPubkey: dest,
      lamports,
    })
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });
  addTx({
    kind: "withdraw",
    amountSol,
    destination: dest.toBase58(),
    signature: sig,
    dryRun: false,
    note: "withdraw",
  });
  return sig;
}

/** Never log or return the secret key. */
export function safeWalletInfo(): {
  address: string;
  keypairPath: string;
  exists: boolean;
  encrypted: boolean;
} {
  const exists = walletExists();
  const encrypted = fs.existsSync(KEYSTORE_PATH);
  return {
    exists,
    encrypted,
    address: exists ? getAddress() : "",
    keypairPath: encrypted ? KEYSTORE_PATH : KEYPAIR_PATH,
  };
}
