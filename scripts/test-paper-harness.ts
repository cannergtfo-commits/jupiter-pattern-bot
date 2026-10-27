/**
 * Lightweight harness tests (node:test) — timing + exit rules, no network.
 * Usage: npm run test:paper
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  YOLO_MAX_HOLD_MS,
  YOLO_SCAN_INTERVAL_MS,
} from "../src/yolo/constants.js";
import {
  decidePaperExit,
  decidePaperSignal,
  runPaperHarness,
} from "../src/yolo/paper-engine.js";
import { collateralPnlPct } from "../src/yolo/mark.js";

describe("yolo constants", () => {
  it("scan is 30s and max hold is 40s", () => {
    assert.equal(YOLO_SCAN_INTERVAL_MS, 30_000);
    assert.equal(YOLO_MAX_HOLD_MS, 40_000);
  });
});

describe("decidePaperSignal", () => {
  it("returns DO NOTHING with thin history", () => {
    assert.equal(decidePaperSignal([100]), "DO NOTHING");
  });
  it("returns LONG on aligned up ticks", () => {
    assert.equal(decidePaperSignal([100, 100.02, 100.04]), "LONG");
  });
  it("returns SHORT on aligned down ticks", () => {
    assert.equal(decidePaperSignal([100, 99.98, 99.96]), "SHORT");
  });
});

describe("decidePaperExit + collateral PnL", () => {
  it("TP fires on collateral PnL at leverage", () => {
    // LONG: +0.11% price * 500x ≈ +55% collateral (clear of float edge at 50%)
    const mark = 100 * 1.0011;
    const pnl = collateralPnlPct("LONG", 100, mark, 500);
    assert.ok(pnl >= 50, `pnl=${pnl}`);
    assert.equal(
      decidePaperExit({
        side: "LONG",
        entry: 100,
        mark,
        leverage: 500,
        holdMs: 5_000,
        maxHoldMs: 40_000,
        tpPct: 50,
        slPct: 20,
      }),
      "tp"
    );
  });

  it("SL fires on adverse move", () => {
    // SHORT adverse = price up 0.05% * 500 = -25% coll (clear of -20% edge)
    const mark = 100 * 1.0005;
    assert.equal(
      decidePaperExit({
        side: "SHORT",
        entry: 100,
        mark,
        leverage: 500,
        holdMs: 1_000,
        maxHoldMs: 40_000,
        tpPct: 50,
        slPct: 20,
      }),
      "sl"
    );
  });

  it("time exit at maxHold even if flat", () => {
    assert.equal(
      decidePaperExit({
        side: "LONG",
        entry: 100,
        mark: 100,
        leverage: 500,
        holdMs: 40_000,
        maxHoldMs: 40_000,
        tpPct: 50,
        slPct: 20,
      }),
      "time"
    );
  });

  it("no exit before maxHold when flat", () => {
    assert.equal(
      decidePaperExit({
        side: "LONG",
        entry: 100,
        mark: 100,
        leverage: 500,
        holdMs: 39_999,
        maxHoldMs: 40_000,
        tpPct: 50,
        slPct: 20,
      }),
      null
    );
  });
});

describe("runPaperHarness timing", () => {
  it("never holds past maxHoldMs and scans on interval", async () => {
    let clock = 1_000_000;
    let mark = 100;
    const events: string[] = [];
    const result = await runPaperHarness({
      durationMs: 120_000,
      scanMs: YOLO_SCAN_INTERVAL_MS,
      pollMs: 5_000,
      maxHoldMs: YOLO_MAX_HOLD_MS,
      forceMinTrades: 2,
      recordLessons: false,
      outPath: "/tmp/paper-harness-test.json",
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      markFetcher: async () => {
        // slight drift so force/signal can open
        mark += 0.0001;
        return mark;
      },
      log: (row) => {
        if (typeof row.event === "string") events.push(row.event);
      },
    });

    assert.ok(result.trades >= 1, "expected at least one paper trade");
    for (const t of result.closed) {
      assert.ok(
        t.holdSec <= YOLO_MAX_HOLD_MS / 1000 + 0.05,
        `hold ${t.holdSec}s exceeded max`
      );
    }
    assert.ok(events.includes("paper_start"));
    assert.ok(events.includes("paper_summary"));
    assert.equal(result.maxHoldSec, 40);
    assert.equal(result.scanSec, 30);
  });
});
