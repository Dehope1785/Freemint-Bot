import { type Hex, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { getPublicClient } from "./chain.js";

export interface FloorData {
  floorPriceEth: number;
  topBidEth: number;
  collectionName: string;
}

// Fetch live floor price and collection stats using Reservoir API
export async function fetchCollectionFloor(contractAddress: string): Promise<FloorData> {
  try {
    const res = await fetch(`https://api-base.reservoir.tools/collections/v5?contract=${contractAddress}`, {
      headers: {
        "Accept": "*/*",
        "x-api-key": process.env.RESERVOIR_API_KEY || "demo-api-key",
      },
    });

    if (res.ok) {
      const data = (await res.json()) as any;
      if (data && data.collections && data.collections.length > 0) {
        const col = data.collections[0];
        return {
          floorPriceEth: col.floorAsk?.price?.amount?.native || 0,
          topBidEth: col.topBid?.price?.amount?.native || 0,
          collectionName: col.name || "Base Collection",
        };
      }
    }
  } catch (err) {
    console.error("Error fetching collection floor:", err);
  }

  return { floorPriceEth: 0, topBidEth: 0, collectionName: "Base NFT" };
}

// Generate and execute a listing on secondary markets (OpenSea/Blur via Reservoir)
export async function executeAutoListing(
  privateKey: Hex,
  contractAddress: string,
  tokenId: string,
  listPriceEth: number
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const account = privateKeyToAccount(privateKey);
    const client = createWalletClient({
      account,
      chain: base,
      transport: http(),
    });

    // Convert ETH price to Wei string
    const weiPrice = BigInt(Math.floor(listPriceEth * 1e18)).toString();

    const res = await fetch("https://api-base.reservoir.tools/execute/list/v5", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.RESERVOIR_API_KEY || "demo-api-key",
      },
      body: JSON.stringify({
        items: [
          {
            token: `${contractAddress}:${tokenId}`,
            weiPrice: weiPrice,
          },
        ],
        taker: account.address,
      }),
    });

    if (!res.ok) {
      return { success: false, error: "Failed to construct marketplace listing order" };
    }

    const data = (await res.json()) as any;
    const step = data?.steps?.find((s: any) => s.items && s.items.length > 0);
    const txData = step?.items?.[0]?.data;

    if (!txData) {
      return { success: false, error: "No transaction payload returned for listing" };
    }

    const txHash = await client.sendTransaction({
      to: txData.to,
      data: txData.data,
      value: BigInt(txData.value || "0"),
    });

    return { success: true, txHash };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}
