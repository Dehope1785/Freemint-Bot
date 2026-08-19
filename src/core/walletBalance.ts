import { formatEther, type Address } from "viem";
import { getPublicClient } from "./chain.js";

export interface WalletBalanceInfo {
  address: string;
  ethBalance: string;
  usdBalance: string;
}

export async function fetchAllWalletsBalances(wallets: Array<{ address: string; isActive: boolean }>): Promise<WalletBalanceInfo[]> {
  const client = getPublicClient();
  
  // Fetch current live ETH price in USD
  let ethPrice = 2100; // fallback price
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    const data = (await res.json()) as { ethereum?: { usd?: number } };
    if (data.ethereum?.usd) {
      ethPrice = data.ethereum.usd;
    }
  } catch {
    // Keep fallback if API fails
  }

  const results: WalletBalanceInfo[] = [];

  for (const w of wallets) {
    try {
      const balanceWei = await client.getBalance({ address: w.address as Address });
      const ethFormatted = formatEther(balanceWei);
      const ethNum = parseFloat(ethFormatted);
      const usdValue = (ethNum * ethPrice).toFixed(2);

      results.push({
        address: w.address,
        ethBalance: ethNum.toFixed(4),
        usdBalance: usdValue,
      });
    } catch {
      results.push({
        address: w.address,
        ethBalance: "0.0000",
        usdBalance: "0.00",
      });
    }
  }

  return results;
}
