import fs from "node:fs";
import path from "node:path";
import { loadConfig, ROOT } from "./config.js";
import { addDenylistMint } from "./filters.js";
import { loadPositions, lossCountForMint, type EntryMeta, type Position } from "./positions.js";
import { loadHistory } from "./history.js";

export type { EntryMeta };

export const LEARNINGS_PATH = path.join(ROOT, "data", "trade-learnings.json");
export const PENDING_SKILL_LESSONS_PATH = path.join(
  ROOT,
  "data",
  "pending-skill-lessons.jsonl"
);

export interface TradeLesson {
  id: string;
  at: string;
  outcome: "win" | "loss";
  reason: "tp" | "sl" | "time";
  symbol: string;
  mint: string;
  entryPriceUsd: number;
  exitPriceUsd: number;
  pnlPct: number;
  holdSeconds: number;
  amountSolSpent: number;
  takeProfitPct: number;
  stopLossPct: number;
  notes: string[];
  lesson: string;
  tags: string[];
  entryMeta?: EntryMeta;
}

export interface LearningsStore {
  generatedAt?: string;
  timezoneNote?: string;
  sample?: unknown;
  tpSummary?: unknown;
  slSummary?: unknown;
  derivedRules?: unknown[];
  newDefaults?: unknown;
  denylistMintsAdded?: string[];
  exitRetuneAt?: string;
  exitRetune?: unknown;
  lessons?: TradeLesson[];
  [key: string]: unknown;
}

function ensureDataDir(): void {
  const dir = path.join(ROOT, "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadLearnings(): LearningsStore {
  ensureDataDir();
  if (!fs.existsSync(LEARNINGS_PATH)) {
    return { generatedAt: new Date().toISOString(), lessons: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(LEARNINGS_PATH, "utf8")) as LearningsStore;
  } catch {
    return { generatedAt: new Date().toISOString(), lessons: [] };
  }
}

export function saveLearnings(store: LearningsStore): void {
  ensureDataDir();
  store.generatedAt = new Date().toISOString();
  fs.writeFileSync(LEARNINGS_PATH, JSON.stringify(store, null, 2) + "\n", "utf8");
}

/** Parse entry meta from a buy history note like:
 *  entry conf=78.1 dex pa=hammer,maru_bull score=86 bias=bullish bond=graduated
 */
export function parseEntryNote(note?: string): EntryMeta | undefined {
  if (!note || !note.includes("entry")) return undefined;
  const meta: EntryMeta = {};
  const conf = note.match(/conf=([\d.]+|\?)/);
  if (conf && conf[1] !== "?") meta.confluenceScore = Number(conf[1]);
  const score = note.match(/score=([\d.]+|\?)/);
  if (score && score[1] !== "?") meta.patternScore = Number(score[1]);
  const bias = note.match(/bias=(\w+)/);
  if (bias) meta.patternBias = bias[1];
  const bond = note.match(/bond=(\w+)/);
  if (bond) meta.bondingStatus = bond[1];
  const pa = note.match(/pa=([^\s]+)/);
  if (pa && pa[1] !== "none") {
    meta.patternTags = pa[1].split(",").filter(Boolean);
  }
  const srcMatch = note.match(/conf=\S+\s+([^\s]+)\s+pa=/);
  if (srcMatch) {
    const raw = srcMatch[1];
    if (raw && raw !== "?" && !raw.startsWith("pa=")) {
      meta.sources = raw.split(/[+,]/).filter((s) => s && s !== "?");
    }
  }
  return Object.keys(meta).length ? meta : undefined;
}

export function findBuyNoteForPosition(pos: Position): string | undefined {
  const hist = loadHistory();
  const buys = hist.transactions.filter(
    (t) => t.kind === "buy" && t.mint === pos.mint && t.symbol === pos.symbol
  );
  const opened = Date.parse(pos.openedAt);
  let best: { note?: string; dist: number } | undefined;
  for (const b of buys) {
    const ts = Date.parse(b.timestamp);
    const dist = Math.abs(ts - opened);
    const sizeOk =
      b.amountSol == null || Math.abs((b.amountSol ?? 0) - pos.amountSolSpent) < 0.0001;
    if (!sizeOk && dist > 120_000) continue;
    if (!best || dist < best.dist) best = { note: b.note, dist };
  }
  return best?.note;
}

function holdSecondsOf(pos: Position, closedAt?: string): number {
  const openMs = Date.parse(pos.openedAt);
  const closeMs = Date.parse(closedAt ?? pos.closedAt ?? new Date().toISOString());
  if (!Number.isFinite(openMs) || !Number.isFinite(closeMs)) return 0;
  return Math.max(0, Math.round((closeMs - openMs) / 1000));
}

function buildHeuristics(args: {
  outcome: "win" | "loss";
  reason: "tp" | "sl" | "time";
  pnlPct: number;
  holdSeconds: number;
  takeProfitPct: number;
  stopLossPct: number;
  entryMeta?: EntryMeta;
  symbol: string;
}): { tags: string[]; notes: string[]; lesson: string } {
  const tags: string[] = [];
  const notes: string[] = [];
  const { outcome, reason, pnlPct, holdSeconds, takeProfitPct, stopLossPct, entryMeta, symbol } =
    args;

  tags.push(outcome, reason);

  if (holdSeconds < 60) {
    tags.push("flash");
    notes.push(`Held only ${holdSeconds}s — flash exit`);
  } else if (holdSeconds < 180) {
    tags.push("quick");
    notes.push(`Held ${holdSeconds}s — quick move`);
  } else if (holdSeconds < 600) {
    tags.push("grind");
    notes.push(`Held ${holdSeconds}s — grind`);
  } else {
    tags.push("slow");
    notes.push(`Held ${holdSeconds}s — slow grind`);
  }

  const nearTp = Math.abs(pnlPct - takeProfitPct) <= Math.max(3, takeProfitPct * 0.25);
  const nearSl = Math.abs(pnlPct + stopLossPct) <= Math.max(3, stopLossPct * 0.25);
  const overshotSl = reason === "sl" && pnlPct < -(stopLossPct + 5);
  const overshotTp = reason === "tp" && pnlPct > takeProfitPct + 5;

  if (reason === "tp" && nearTp) {
    tags.push("clean_continuation");
    notes.push(`PnL ${pnlPct.toFixed(1)}% near TP +${takeProfitPct}% — clean continuation`);
  }
  if (reason === "sl" && nearSl) {
    tags.push("rejection");
    notes.push(`PnL ${pnlPct.toFixed(1)}% near SL -${stopLossPct}% — rejection/dump`);
  }
  if (overshotSl) {
    tags.push("flash_dump");
    notes.push(`Overshot SL to ${pnlPct.toFixed(1)}% — thin liquidity / dump`);
  }
  if (overshotTp) {
    tags.push("momentum_overshoot");
    notes.push(`Overshot TP to ${pnlPct.toFixed(1)}% — strong momentum`);
  }

  if (entryMeta?.patternTags?.length) {
    tags.push(...entryMeta.patternTags.map((t) => `pa:${t}`));
    notes.push(`Entry PA: ${entryMeta.patternTags.join(",")}`);
  }
  if (entryMeta?.patternScore != null) {
    notes.push(`patternScore=${entryMeta.patternScore}`);
  }
  if (entryMeta?.patternBias) {
    tags.push(`bias:${entryMeta.patternBias}`);
  }
  if (entryMeta?.confluenceScore != null) {
    notes.push(`confluence=${entryMeta.confluenceScore}`);
    if (entryMeta.confluenceScore >= 70) tags.push("high_conf");
    else if (entryMeta.confluenceScore < 50) tags.push("low_conf");
  }
  if (entryMeta?.sources?.length) {
    tags.push(...entryMeta.sources.map((s) => `src:${s}`));
    notes.push(`sources=${entryMeta.sources.join("+")}`);
  }
  if (entryMeta?.bondingStatus) {
    tags.push(`bond:${entryMeta.bondingStatus}`);
  }

  if (reason === "time") {
    tags.push("max_hold");
    notes.push(`Time exit after ${holdSeconds}s (max-hold rule)`);
  }

  let lesson: string;
  if (reason === "time") {
    lesson = `${symbol} time-exited at ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% after ${holdSeconds}s — capital recycled past max hold; ${
      pnlPct >= 0 ? "stale winner that never hit TP" : "stale loser that never hit SL"
    }. Prefer setups that resolve faster or tighten max hold.`;
  } else if (outcome === "win") {
    if (holdSeconds < 60) {
      lesson = `${symbol} hit TP (+${pnlPct.toFixed(1)}%) in ${holdSeconds}s — flash continuation; prefer similar PA/momentum entries.`;
    } else {
      lesson = `${symbol} took profit (+${pnlPct.toFixed(1)}%) after ${holdSeconds}s${
        entryMeta?.patternTags?.length ? ` with ${entryMeta.patternTags.join("/")}` : ""
      } — ${nearTp ? "clean TP hit" : "momentum win"}; keep setups that grind without immediate rejection.`;
    }
  } else {
    if (holdSeconds < 60 || overshotSl) {
      lesson = `${symbol} stopped out (${pnlPct.toFixed(1)}%) in ${holdSeconds}s — flash dump/rejection; tighten entry filters (5m fade, thin liq, blocked PA) and avoid re-entering this mint soon.`;
    } else {
      lesson = `${symbol} hit SL (${pnlPct.toFixed(1)}%) after ${holdSeconds}s${
        entryMeta?.confluenceScore != null ? ` despite conf=${entryMeta.confluenceScore}` : ""
      } — entry quality failed; require stronger preferred PA / avoid fading 5m.`;
    }
  }

  return { tags: [...new Set(tags)], notes, lesson };
}

export interface RecordLessonArgs {
  position: Position;
  reason: "tp" | "sl" | "time";
  exitPriceUsd: number;
  closedAt?: string;
  entryMeta?: EntryMeta;
}

export function recordClosedTradeLesson(args: RecordLessonArgs): TradeLesson | null {
  const { position: pos, reason, exitPriceUsd } = args;
  if (reason !== "tp" && reason !== "sl" && reason !== "time") return null;

  const closedAt = args.closedAt ?? pos.closedAt ?? new Date().toISOString();
  const entry =
    args.entryMeta ?? pos.entryMeta ?? parseEntryNote(findBuyNoteForPosition(pos));

  const pnlPct =
    pos.entryPriceUsd > 0 ? ((exitPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100 : 0;
  const holdSeconds = holdSecondsOf(pos, closedAt);
  const outcome: "win" | "loss" =
    reason === "tp" ? "win" : reason === "sl" ? "loss" : pnlPct >= 0 ? "win" : "loss";

  const { tags, notes, lesson } = buildHeuristics({
    outcome,
    reason,
    pnlPct,
    holdSeconds,
    takeProfitPct: pos.takeProfitPct,
    stopLossPct: pos.stopLossPct,
    entryMeta: entry,
    symbol: pos.symbol,
  });

  const tradeLesson: TradeLesson = {
    id: pos.id,
    at: closedAt,
    outcome,
    reason,
    symbol: pos.symbol,
    mint: pos.mint,
    entryPriceUsd: pos.entryPriceUsd,
    exitPriceUsd,
    pnlPct: Number(pnlPct.toFixed(4)),
    holdSeconds,
    amountSolSpent: pos.amountSolSpent,
    takeProfitPct: pos.takeProfitPct,
    stopLossPct: pos.stopLossPct,
    notes,
    lesson,
    tags,
    ...(entry ? { entryMeta: entry } : {}),
  };

  const store = loadLearnings();
  if (!Array.isArray(store.lessons)) store.lessons = [];
  const existingIdx = store.lessons.findIndex((l) => l.id === pos.id);
  if (existingIdx >= 0) {
    store.lessons[existingIdx] = tradeLesson;
  } else {
    store.lessons.push(tradeLesson);
  }
  saveLearnings(store);

  ensureDataDir();
  let alreadyPending = false;
  if (fs.existsSync(PENDING_SKILL_LESSONS_PATH)) {
    const lines = fs
      .readFileSync(PENDING_SKILL_LESSONS_PATH, "utf8")
      .split("\n")
      .filter(Boolean);
    alreadyPending = lines.some((line) => {
      try {
        const o = JSON.parse(line) as { id?: string };
        return o.id === pos.id;
      } catch {
        return false;
      }
    });
  }
  if (!alreadyPending) {
    const pending = {
      id: pos.id,
      at: closedAt,
      outcome,
      symbol: pos.symbol,
      mint: pos.mint,
      pnlPct: tradeLesson.pnlPct,
      holdSeconds,
      lesson,
      tags,
    };
    fs.appendFileSync(PENDING_SKILL_LESSONS_PATH, JSON.stringify(pending) + "\n", "utf8");
  }


  // Auto-denylist toxic mints (SL flash dumps / red cuts / repeat losers)
  try {
    const cfg = loadConfig();
    const reasons: string[] = [];
    if (cfg.autoDenylistOnSl && reason === "sl") reasons.push("sl");
    if (cfg.autoDenylistOnRedCut && reason === "time" && pnlPct <= 0) reasons.push("red_cut");
    const losses = lossCountForMint(pos.mint);
    if (cfg.autoDenylistAfterLosses > 0 && losses >= cfg.autoDenylistAfterLosses) {
      reasons.push(`losses=${losses}`);
    }
    if (reasons.length) {
      addDenylistMint(pos.mint, `${pos.symbol} ${reasons.join("+")}`);
    }
  } catch (e) {
    console.log(`[learning] auto-denylist skip: ${(e as Error).message}`);
  }

  console.log(
    `[learning] ${outcome.toUpperCase()} ${pos.symbol} ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% hold=${holdSeconds}s — ${lesson}`
  );

  return tradeLesson;
}

/** Backfill lessons for closed tp/sl positions missing from learnings. */
export function backfillMissingLessons(): {
  added: number;
  skipped: number;
  totalClosed: number;
} {
  const store = loadPositions();
  const learnings = loadLearnings();
  const have = new Set((learnings.lessons ?? []).map((l) => l.id));
  let added = 0;
  let skipped = 0;
  const closed = store.positions.filter(
    (p) => p.status === "closed" && (p.closeReason === "tp" || p.closeReason === "sl")
  );
  for (const pos of closed) {
    if (have.has(pos.id)) {
      skipped++;
      continue;
    }
    if (pos.exitPriceUsd == null || !pos.closeReason) {
      skipped++;
      continue;
    }
    const reason = pos.closeReason;
    if (reason !== "tp" && reason !== "sl") {
      skipped++;
      continue;
    }
    const lesson = recordClosedTradeLesson({
      position: pos,
      reason,
      exitPriceUsd: pos.exitPriceUsd,
      closedAt: pos.closedAt,
    });
    if (lesson) {
      added++;
      have.add(pos.id);
    } else {
      skipped++;
    }
  }
  return { added, skipped, totalClosed: closed.length };
}
