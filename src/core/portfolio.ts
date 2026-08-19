import { type Hex, createWalletClient, http, parseAbi, createPublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { getPublicClient } from "./chain.js";
import { prisma } from "../db/client.js";

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
  const normalizedAddr = walletAddress.toLowerCase() as `0x${string}`;
  const publicClient = getPublicClient();

  try {
    // 1. Fetch recent minted contracts from database history for this wallet's user or global drops
    const history = await prisma.mintHistory.findMany({
      where: { status: "SUCCESS", txHash: { not: null } },
      orderBy: { timestamp: "desc" },
      take: 15,
    });

    const uniqueContracts = Array.from(new Set(history.map((h) => h.contractAddress)));

    // 2. Check on-chain balance and token ownership for each known contract
    for (const contractAddr of uniqueContracts) {
      try {
        const cAddr = contractAddr as `0x${string}`;
        
        // Check balance of this NFT contract for this wallet
        const balance = (await publicClient.readContract({
          address: cAddr,
          abi: parseAbi(["function balanceof(address owner) view returns (uint256)", "function balanceOf(address owner) view returns (uint256)"]),
          functionName: "balanceOf",
          args: [normalizedAddr],
        }).catch(() => 0n)) as bigint;

        if (balance && balance > 0n) {
          // If wallet owns tokens here, look up recent tokenIds or scan first few IDs
          items.push({
            contractAddress: cAddr,
            tokenId: "Owned",
            collectionName: `Contract ${cAddr.slice(0, 6)}...`,
            floorPriceEth: 0,
            topBidEth: 0,
            openseaUrl: `https://opensea.io/assets/base/${cAddr}`,
          });
        }
      } catch {
        // Skip if contract doesn't standardly support balanceOf or fails
      }
    }
  } catch (err) {
    console.error("On-chain portfolio check error:", err);
  }

  // Fallback to Reservoir if on-chain check returns nothing yet
  if (items.length === 0) {
    try {
      const res = await fetch(
        `https://api-base.reservoir.tools/users/${normalizedAddr}/tokens/v7?limit=10`,
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
            items.push({
              contractAddress: token.contract,
              tokenId: token.tokenId,
              collectionName: token.collection?.name || "Base NFT",
              floorPriceEth: 0,
              topBidEth: 0,
              openseaUrl: `https://opensea.io/assets/base/${token.contract}/${token.tokenId}`,
            });
          }
        }
      }
    } catch (e) {
      // Ignore reservoir fallback errors
    }
  }

  return {
    walletAddress,
    items,
    totalNfts: items.length,
    totalFloorValueEth: 0,
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
      return { success: false, error: "No active bids found on secondary markets" };
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

    return { success: true, payoutEth: 0, txHash };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}
