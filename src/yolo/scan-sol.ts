/**
 * SOL market scan for YOLO LONG / SHORT / DO NOTHING using solana-skill patterns.
 */
import { analyzePatterns, fetchOhlcvForPair, type CandleBar } from "../patterns.js";
import { fetchSolMarkUsd } from "./mark.js";
import type { YoloScanRec } from "./types.js";

/** Well-known SOL/USDC Raydium/Orca pools — GeckoTerminal may accept one of these. */
const SOL_POOL_CANDIDATES = [
  "58oQChx4yWmvKwrYbQxNdtspzUZUoZHh9DjgDAJgJKpp", // Raydium SOL/USDC
  "8BnEgHoWFds5Z5YnA9bqEDAmKWRG7qzmAB5iQu9orEug",
];

async function fetchSolBars(): Promise<CandleBar[] | null> {
  for (const pool of SOL_POOL_CANDIDATES) {
    const bars = await fetchOhlcvForPair(pool);
    if (bars && bars.length >= 5) return bars;
  }
  return null;
}

/** DexScreener SOL proxy when OHLCV missing. */
async function fetchSolProxyToken(): Promise<{
  priceUsd: number;
  priceChange5m?: number;
  priceChange1h?: number;
  priceChange6h?: number;
  volume24hUsd?: number;
}> {
  const mark = await fetchSolMarkUsd();
  try {
    const r = await fetch(
      "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112",
      { signal: AbortSignal.timeout(8_000), headers: { Accept: "application/json" } }
    );
    if (r.ok) {
      const j = (await r.json()) as {
        pairs?: Array<{
          priceUsd?: string;
          priceChange?: { m5?: number; h1?: number; h6?: number };
          volume?: { h24?: number };
          quoteToken?: { symbol?: string };
          liquidity?: { usd?: number };
        }>;
      };
      const pairs = (j.pairs ?? [])
        .filter((p) => /USD|USDC|USDT/i.test(p.quoteToken?.symbol ?? ""))
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const top = pairs[0];
      if (top) {
        return {
          priceUsd: Number(top.priceUsd) || mark,
          priceChange5m: top.priceChange?.m5,
          priceChange1h: top.priceChange?.h1,
          priceChange6h: top.priceChange?.h6,
          volume24hUsd: top.volume?.h24,
        };
      }
    }
  } catch {
    /* ignore */
  }
  return { priceUsd: mark };
}

export async function scanSolForYolo(): Promise<YoloScanRec> {
  const bars = await fetchSolBars();
  const proxy = await fetchSolProxyToken();
  const token = {
    mint: "So11111111111111111111111111111111111111112",
    symbol: "SOL",
    name: "Solana",
    priceUsd: proxy.priceUsd,
    liquidityUsd: 1_000_000_000,
    volume24hUsd: proxy.volume24hUsd ?? 0,
    volumeSpikeRatio: 1,
    priceChange5m: proxy.priceChange5m,
    priceChange1h: proxy.priceChange1h,
    priceChange6h: proxy.priceChange6h,
    source: "yolo-sol" as const,
    pairAgeMinutes: 999999,
  };
  // patterns.analyzePatterns expects CandidateToken — cast lightly
  const analysis = analyzePatterns(token as never, bars);
  const mark = proxy.priceUsd;
  const tags = analysis.tags;
  const score = analysis.bullishScore;
  const bias = analysis.bias;

  const bull =
    bias === "bullish" ||
    tags.some((t) => ["maru_bull", "3soldiers", "hammer", "bull_engulf"].includes(t));
  const bear =
    bias === "bearish" ||
    tags.some((t) => ["maru_bear", "3crows", "shoot_star", "bear_engulf", "hang_man"].includes(t));

  if (bull && !bear && score >= 58) {
    return {
      action: "LONG",
      market: "SOL",
      markUsd: mark,
      reason: `bullish PA score=${score} tags=[${tags.join(",")}] quality=${analysis.dataQuality}`,
      tags,
      score,
      bias,
    };
  }
  if (bear && !bull && score <= 42) {
    return {
      action: "SHORT",
      market: "SOL",
      markUsd: mark,
      reason: `bearish PA score=${score} tags=[${tags.join(",")}] quality=${analysis.dataQuality}`,
      tags,
      score,
      bias,
    };
  }
  // Momentum fallback on 5m %
  const m5 = proxy.priceChange5m;
  if (typeof m5 === "number") {
    if (m5 >= 0.15) {
      return {
        action: "LONG",
        market: "SOL",
        markUsd: mark,
        reason: `5m +${m5.toFixed(2)}% momentum (thin PA) score=${score}`,
        tags,
        score,
        bias,
      };
    }
    if (m5 <= -0.15) {
      return {
        action: "SHORT",
        market: "SOL",
        markUsd: mark,
        reason: `5m ${m5.toFixed(2)}% dump (thin PA) score=${score}`,
        tags,
        score,
        bias,
      };
    }
  }
  return {
    action: "DO NOTHING",
    market: "SOL",
    markUsd: mark,
    reason: `unclear score=${score} bias=${bias} tags=[${tags.join(",") || "none"}]`,
    tags,
    score,
    bias,
  };
}
