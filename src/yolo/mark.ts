/** SOL/USD mark — spot proxy for YOLO (Pyth Pro fill may differ ~2s). */

const SOL_MINT = "So11111111111111111111111111111111111111112";

export async function fetchSolMarkUsd(): Promise<number> {
  try {
    const r = await fetch(`https://api.jup.ag/price/v2?ids=${SOL_MINT}`, {
      signal: AbortSignal.timeout(8_000),
      headers: { Accept: "application/json", "User-Agent": "jupiter-pattern-bot/yolo" },
    });
    if (r.ok) {
      const j = (await r.json()) as { data?: Record<string, { price?: string | number }> };
      const p = j?.data?.[SOL_MINT]?.price;
      const n = typeof p === "string" ? Number(p) : typeof p === "number" ? p : NaN;
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    /* fall through */
  }
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      {
        signal: AbortSignal.timeout(8_000),
        headers: { Accept: "application/json", "User-Agent": "jupiter-pattern-bot/yolo" },
      }
    );
    if (r.ok) {
      const j = (await r.json()) as { solana?: { usd?: number } };
      if (typeof j?.solana?.usd === "number" && j.solana.usd > 0) return j.solana.usd;
    }
  } catch {
    /* fall through */
  }
  throw new Error("fetchSolMarkUsd: no price");
}

/** Collateral PnL % ≈ signed price move % × leverage. */
export function collateralPnlPct(
  side: "LONG" | "SHORT",
  entry: number,
  mark: number,
  leverage: number
): number {
  const priceMove = ((mark - entry) / entry) * 100;
  const signed = side === "LONG" ? priceMove : -priceMove;
  return signed * leverage;
}
