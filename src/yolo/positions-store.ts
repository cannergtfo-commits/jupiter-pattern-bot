import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import type { YoloPosition } from "./types.js";

const STORE = path.join(ROOT, "data", "yolo-positions.json");

function ensure(): void {
  const dir = path.dirname(STORE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadYoloPositions(): YoloPosition[] {
  ensure();
  if (!fs.existsSync(STORE)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(STORE, "utf8")) as { positions?: YoloPosition[] };
    return Array.isArray(j.positions) ? j.positions : [];
  } catch {
    return [];
  }
}

function save(all: YoloPosition[]): void {
  ensure();
  fs.writeFileSync(STORE, JSON.stringify({ positions: all }, null, 2) + "\n", "utf8");
}

export function openYoloPositions(): YoloPosition[] {
  return loadYoloPositions().filter((p) => p.status === "open");
}

export function addYoloPosition(pos: YoloPosition): void {
  const all = loadYoloPositions();
  all.push(pos);
  save(all);
}

export function closeYoloPosition(
  id: string,
  reason: NonNullable<YoloPosition["closeReason"]>,
  exitMarkUsd: number,
  collateralPnlPct: number
): void {
  const all = loadYoloPositions();
  const p = all.find((x) => x.id === id);
  if (!p) return;
  p.status = "closed";
  p.closeReason = reason;
  p.closedAt = new Date().toISOString();
  p.exitMarkUsd = exitMarkUsd;
  p.collateralPnlPct = collateralPnlPct;
  save(all);
}

export function hasOpenYolo(): boolean {
  return openYoloPositions().length > 0;
}
