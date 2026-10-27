import { openPositions, closePosition } from "../src/positions.js";
import { swapTokenToSol } from "../src/swap.js";
import { getTokenPriceUsd } from "../src/scanners/dexscreener.js";
import { jupiterPriceUsd } from "../src/scanners/jupiter.js";
import { addTx } from "../src/history.js";
import { loadConfig } from "../src/config.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { loadKeypair, getBalanceSol } from "../src/wallet.js";

async function main() {
  const cfg = loadConfig();
  const positions = openPositions();
  console.log(`Open positions: ${positions.length}`);

  for (const pos of positions) {
    let price = await getTokenPriceUsd(pos.mint);
    if (price === null) {
      const jp = await jupiterPriceUsd([pos.mint]);
      price = jp[pos.mint] ?? 0;
    }
    console.log(`Selling ${pos.symbol} amountToken=${pos.amountToken} price=$${price}`);
    let txSell: string | undefined;
    if (pos.amountToken > 0) {
      const swap = await swapTokenToSol(pos.mint, pos.amountToken);
      if (!swap.ok) {
        console.log(`Sell failed ${pos.symbol}: ${swap.error}`);
      } else {
        txSell = swap.signature;
        console.log(`Sold ${pos.symbol} sig=${txSell}`);
        if (swap.detail) console.log(swap.detail);
      }
    }
    const px = price || pos.entryPriceUsd;
    const pnlPct = pos.entryPriceUsd > 0 ? ((px - pos.entryPriceUsd) / pos.entryPriceUsd) * 100 : 0;
    addTx({
      kind: "sell",
      mint: pos.mint,
      symbol: pos.symbol,
      amountSol: pos.amountSolSpent,
      amountToken: pos.amountToken,
      priceUsd: px,
      pnlPct,
      pnlSol: pos.amountSolSpent * (pnlPct / 100),
      signature: txSell,
      dryRun: cfg.dryRun || pos.dryRun,
      note: "exit:manual_flatten",
    });
    closePosition(pos.id, "tp", px, txSell);
  }

  const kp = loadKeypair();
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  async function accounts(program: PublicKey) {
    try {
      return await conn.getParsedTokenAccountsByOwner(kp.publicKey, { programId: program });
    } catch (e) {
      console.log("token accounts error", (e as Error).message);
      return { value: [] as { account: any }[] };
    }
  }
  const a1 = await accounts(TOKEN_PROGRAM);
  const a2 = await accounts(TOKEN_2022);
  for (const { account } of [...a1.value, ...a2.value]) {
    const info = account.data.parsed.info;
    const mint = info.mint as string;
    const amount = BigInt(info.tokenAmount.amount);
    const ui = info.tokenAmount.uiAmount;
    if (amount <= 0n) continue;
    console.log(`Leftover ${mint.slice(0, 8)}… ui=${ui} raw=${amount}`);
    const swap = await swapTokenToSol(mint, Number(amount));
    if (!swap.ok) console.log(`  flatten fail: ${swap.error}`);
    else console.log(`  flattened ${swap.signature}`);
  }

  console.log("Balance SOL:", await getBalanceSol());
  console.log("Open left:", openPositions().length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
