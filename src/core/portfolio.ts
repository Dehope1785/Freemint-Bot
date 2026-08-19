import { type Hex, createWalletClient, http, custom } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { getPublicClient } from "./chain.js";

export interface PortfolioItem {
  contractAddress: string;
  tokenId: string;
  collectionName: string;
  floorPriceEth: number;
  topBidEth: number;
  openseaUrl: string;
}

export interface WalletPortfolio {
  walletAddress: string;
  items: PortfolioItem[];
  totalNfts: number;
  totalFloorValueEth: number;
}

export async function fetchWalletPortfolio(walletAddress: string): Promise<WalletPortfolio> {
  const items: PortfolioItem[] = [];
  const normalizedAddr = walletAddress.toLowerCase();

  try {
    // 1. Fetch via Reservoir Base Indexer
    const res = await fetch(
      `https://api-base.reservoir.tools/users/${normalizedAddr}/tokens/v7?limit=20`,
      {
        headers: {
          "Accept": "*/*",
          "x-api-key": process.env.RESERVOIR_API_KEY || "demo-api-key",
        },
      }
    );

    if (res.ok) {
      const data = (await res.json()) as any;
      if (data && Array.isArray(data.tokens)) {
        for (const t of data.tokens) {
          const token = t.token;
          const market = t.market;
          const floor = market?.floorAsk?.price?.amount?.native ?? 0;
          const topBid = market?.topBid?.price?.amount?.native ?? 0;

          items.push({
            contractAddress: token.contract,
            tokenId: token.tokenId,
            collectionName: token.collection?.name || token.name || "Base NFT",
            floorPriceEth: typeof floor === "number" ? floor : parseFloat(floor || "0"),
            topBidEth: typeof topBid === "number" ? topBid : parseFloat(topBid || "0"),
            openseaUrl: `https://opensea.io/assets/base/${token.contract}/${token.tokenId}`,
          });
        }
      }
    }
  } catch (err) {
    console.error("Portfolio Reservoir query error:", err);
  }

  // 2. OpenSea Fallback if items empty
  if (items.length === 0) {
    try {
      const osRes = await fetch(
        `https://api.opensea.io/api/v2/chain/base/account/${normalizedAddr}/nfts?limit=20`,
        {
          headers: {
            "Accept": "application/json",
            "X-API-KEY": process.env.OPENSEA_API_KEY || "",
          },
        }
      );

      if (osRes.ok) {
        const osData = (await osRes.json()) as any;
        if (osData && Array.isArray(osData.nfts)) {
          for (const nft of osData.nfts) {
            items.push({
              contractAddress: nft.contract,
              tokenId: nft.identifier,
              collectionName: nft.collection || nft.name || "Base NFT",
              floorPriceEth: 0,
              topBidEth: 0,
              openseaUrl: nft.opensea_url || `https://opensea.io/assets/base/${nft.contract}/${nft.identifier}`,
            });
          }
        }
      }
    } catch (osErr) {
      console.error("Portfolio OpenSea query fallback error:", osErr);
    }
  }

  const totalFloor = items.reduce((sum, i) => sum + i.floorPriceEth, 0);

  return {
    walletAddress,
    items,
    totalNfts: items.length,
    totalFloorValueEth: totalFloor,
  };
}

export async function executeSell(
  privateKey: Hex,
  contractAddress: string,
  tokenId: string
): Promise<{ success: boolean; payoutEth?: number; txHash?: string; error?: string }> {
  try {
    const account = privateKeyToAccount(privateKey);
    const client = createWalletClient({
      account,
      chain: base,
      transport: http(),
    });

    const res = await fetch("https://api-base.reservoir.tools/execute/sell/v7", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.RESERVOIR_API_KEY || "demo-api-key",
      },
      body: JSON.stringify({
        token: `${contractAddress}:${tokenId}`,
        taker: account.address,
      }),
    });

    if (!res.ok) {
      const errJson = (await res.json()) as any;
      return {
        success: false,
        error: errJson?.message || "No active bids found on secondary markets",
      };
    }

    const data = (await res.json()) as any;
    const step = data?.steps?.find((s: any) => s.items && s.items.length > 0);
    const txData = step?.items?.[0]?.data;

    if (!txData) {
      return { success: false, error: "Unable to construct sell order route" };
    }

    const txHash = await client.sendTransaction({
      to: txData.to,
      data: txData.data,
      value: BigInt(txData.value || "0"),
    });

    const payout = data?.path?.[0]?.buyIn?.amount?.native ?? 0;

    return {
      success: true,
      payoutEth: payout,
      txHash,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || String(err),
    };
  }
}
