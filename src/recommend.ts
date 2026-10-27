/**
 * Per-scan recommendation: LONG / SHORT / DO NOTHING.
 * Jupiter spot path is long-only (buy token / sell to SOL).
 * SHORT is signal-only: skip new buys; if a long is open on that mint, prefer closing.
 */
import chalk from "chalk";
import type { AppConfig } from "./config.js";
import type { ScanReportRow } from "./strategy.js";
import { hasGoodSetup, setupRejectReason } from "./confluence.js";
import { hasOpenMint, openPositions } from "./positions.js";

export type RecAction = "LONG" | "SHORT" | "DO NOTHING";

export interface Recommendation {
  action: RecAction;
  symbol: string;
  mint: string;
  reason: string;
  /** If SHORT and we hold this mint, suggest closing the long. */
  closeOpenLong?: boolean;
}

function setupOpts(cfg: AppConfig) {
  return {
    preferredTags: cfg.preferredPatternTags,
    blockedTags: cfg.blockedPatternTags,
    requirePreferredTag: cfg.requirePreferredPatternTag,
    minPriceChange5mPct: cfg.minPriceChange5mPct,
    minPreferredTagCount: cfg.minPreferredTagCount,
    requireMomentumTag: cfg.requireMomentumPatternTag,
    momentumTags: cfg.momentumPatternTags,
  };
}

export function recommendForRow(row: ScanReportRow, cfg: AppConfig): Recommendation {
  const t = row.token;
  const tags = t.patternTags ?? row.patternTags ?? [];
  const bias = (t.patternBias ?? row.patternBias ?? "neutral") as string;
  const score = t.patternScore ?? row.patternScore ?? 0;
  const blockedHit = cfg.blockedPatternTags.some((b) => tags.includes(b));
  const pc5 = t.priceChange5m;
  const dumping = typeof pc5 === "number" && pc5 <= -8;
  const open = hasOpenMint(t.mint);

  if (blockedHit || bias === "bearish" || dumping) {
    return {
      action: "SHORT",
      symbol: t.symbol,
      mint: t.mint,
      reason: blockedHit
        ? `bearish tags [${tags.join(",")}] — signal only (no short venue on Jupiter spot)`
        : dumping
          ? `5m ${pc5!.toFixed(1)}% dump — signal only; skip entry`
          : `bearish bias score=${score} — signal only`,
      closeOpenLong: open,
    };
  }

  if (row.filterPass) {
    const good = hasGoodSetup(t, cfg.minPatternScore, setupOpts(cfg));
    if (good) {
      return {
        action: "LONG",
        symbol: t.symbol,
        mint: t.mint,
        reason: `setup ok score=${score} tags=[${tags.join(",")}] conf=${t.confluenceScore ?? row.confluenceScore ?? "?"}`,
      };
    }
    const why = setupRejectReason(t, cfg.minPatternScore, setupOpts(cfg));
    return {
      action: "DO NOTHING",
      symbol: t.symbol,
      mint: t.mint,
      reason: why || "filters passed but setup unclear",
    };
  }

  return {
    action: "DO NOTHING",
    symbol: t.symbol,
    mint: t.mint,
    reason: row.filterReasons.slice(0, 2).join(" | ") || "filtered out",
  };
}

/** Pick primary recommendation for this scan cycle + print banner. */
export function printScanRecommendation(rows: ScanReportRow[], cfg: AppConfig): Recommendation {
  const opens = openPositions();
  // Prefer best passing long candidate; else strongest bearish signal; else DO NOTHING
  const sorted = [...rows].sort(
    (a, b) => (b.confluenceScore ?? b.token.confluenceScore ?? 0) - (a.confluenceScore ?? a.token.confluenceScore ?? 0)
  );
  let primary: Recommendation | null = null;
  for (const row of sorted.slice(0, 12)) {
    const rec = recommendForRow(row, cfg);
    if (rec.action === "LONG" && row.filterPass) {
      primary = rec;
      break;
    }
    if (!primary && rec.action === "SHORT") primary = rec;
  }
  if (!primary) {
    primary = {
      action: "DO NOTHING",
      symbol: sorted[0]?.token.symbol ?? "—",
      mint: sorted[0]?.token.mint ?? "",
      reason: rows.length ? "no clear long/short setup this cycle" : "no candidates",
    };
  }

  const color =
    primary.action === "LONG"
      ? chalk.green.bold
      : primary.action === "SHORT"
        ? chalk.red.bold
        : chalk.yellow.bold;

  console.log("");
  console.log(chalk.bold("════════════ SCAN RECOMMENDATION ════════════"));
  console.log(color(`  >>> ${primary.action} <<<`));
  console.log(
    chalk.white(
      `  focus: ${primary.symbol}${primary.mint ? " " + primary.mint.slice(0, 8) + "…" : ""}`
    )
  );
  console.log(chalk.dim(`  why: ${primary.reason}`));
  if (primary.action === "SHORT") {
    console.log(
      chalk.dim(
        "  note: Jupiter spot is long-only — SHORT = signal / avoid entry" +
          (primary.closeOpenLong ? "; open long on this mint → prefer close" : "")
      )
    );
  }
  if (opens.length) {
    console.log(
      chalk.dim(
        `  open longs: ${opens.map((p) => p.symbol).join(", ")} (exits: TP +${cfg.takeProfitPct}% / SL −${cfg.stopLossPct}% / max ${cfg.maxHoldSeconds || "?"}s)`
      )
    );
  }
  console.log(chalk.bold("═════════════════════════════════════════════"));
  console.log("");
  return primary;
}
