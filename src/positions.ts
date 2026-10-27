import fs from "node:fs";
import path from "node:path";
import { POSITIONS_PATH, ROOT } from "./config.js";

/** Snapshot of confluence/PA at entry for post-trade learning. */
export interface EntryMeta {
  confluenceScore?: number;
  sources?: string[];
  patternTags?: string[];
  patternScore?: number;
  patternBias?: string;
  bondingStatus?: string;
  filterNotes?: string[];
}

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  entryPriceUsd: number;
  amountToken: number;
  amountSolSpent: number;
  takeProfitPct: number;
  stopLossPct: number;
  openedAt: string;
  status: "open" | "closed";
  closeReason?: "tp" | "sl" | "manual" | "time";
  closedAt?: string;
  exitPriceUsd?: number;
  dryRun: boolean;
  txBuy?: string;
  txSell?: string;
  entryMeta?: EntryMeta;
}

export interface PositionsStore {
  positions: Position[];
}

function ensureDataDir(): void {
  const dir = path.join(ROOT, "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadPositions(): PositionsStore {
  ensureDataDir();
  if (!fs.existsSync(POSITIONS_PATH)) {
    return { positions: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(POSITIONS_PATH, "utf8")) as PositionsStore;
  } catch {
    return { positions: [] };
  }
}

export function savePositions(store: PositionsStore): void {
  ensureDataDir();
  fs.writeFileSync(POSITIONS_PATH, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export function openPositions(): Position[] {
  return loadPositions().positions.filter((p) => p.status === "open");
}

export function addPosition(pos: Position): void {
  const store = loadPositions();
  store.positions.push(pos);
  savePositions(store);
}

export function closePosition(
  id: string,
  reason: "tp" | "sl" | "manual" | "time",
  exitPriceUsd: number,
  txSell?: string
): void {
  const store = loadPositions();
  const p = store.positions.find((x) => x.id === id);
  if (!p) return;
  p.status = "closed";
  p.closeReason = reason;
  p.closedAt = new Date().toISOString();
  p.exitPriceUsd = exitPriceUsd;
  if (txSell) p.txSell = txSell;
  savePositions(store);
}

export function hasOpenMint(mint: string): boolean {
  return openPositions().some((p) => p.mint === mint);
}

export function lastClosedForMint(mint: string): Position | undefined {
  const closed = loadPositions()
    .positions.filter((p) => p.status === "closed" && p.mint === mint && p.closedAt)
    .sort((a, b) => Date.parse(b.closedAt!) - Date.parse(a.closedAt!));
  return closed[0];
}

/** Total open+closed entries recorded for a mint (for maxEntriesPerMint gate). */
export function entryCountForMint(mint: string): number {
  return loadPositions().positions.filter((p) => p.mint === mint).length;
}

/** Count closed trades with negative/zero pnl or SL reason as losses for a mint. */
export function lossCountForMint(mint: string): number {
  let n = 0;
  for (const p of loadPositions().positions) {
    if (p.status !== "closed" || p.mint !== mint) continue;
    if (p.closeReason === "sl") {
      n++;
      continue;
    }
    if (p.exitPriceUsd == null || !(p.entryPriceUsd > 0)) continue;
    const pnl = ((p.exitPriceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100;
    if (pnl <= 0) n++;
  }
  return n;
}
