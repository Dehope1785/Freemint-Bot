import { type Hex, parseAbi, type Address } from "viem";
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
  const normalizedAddr = walletAddress.toLowerCase() as Address;
  const publicClient = getPublicClient();
  const seenContracts = new Set<string>();

  try {
    // 1. Fetch all successful mint history records from the database
    const history = await prisma.mintHistory.findMany({
      where: { status: "SUCCESS", txHash: { not: null } },
      orderBy: { timestamp: "desc" },
      take: 50,
    });

    for (const h of history) {
      if (h.contractAddress && !seenContracts.has(h.contractAddress.toLowerCase())) {
        seenContracts.add(h.contractAddress.toLowerCase());
      }
    }

    // 2. Query each unique contract directly on-chain for ownership / balance
    for (const contractAddr of seenContracts) {
      try {
        const cAddr = contractAddr as Address;

        // Check ERC-721 balance for this specific wallet
        const balance = (await publicClient.readContract({
          address: cAddr,
          abi: parseAbi([
            "function balanceOf(address owner) view returns (uint256)",
            "function name() view returns (string)",
          ]),
          functionName: "balanceOf",
          args: [normalizedAddr],
        }).catch(() => 0n)) as bigint;

        if (balance && balance > 0n) {
          let collectionName = `Base NFT Collection`;
          try {
            const nameResult = (await publicClient.readContract({
              address: cAddr,
              abi: parseAbi(["function name() view returns (string)"]),
              functionName: "name",
            })) as string;
            if (nameResult) collectionName = nameResult;
          } catch {
            // Fallback name
          }

          items.push({
            contractAddress: cAddr,
            tokenId: `1+ (${balance.toString()} total)`,
            collectionName: `${collectionName}`,
            floorPriceEth: 0,
            topBidEth: 0,
            openseaUrl: `https://opensea.io/assets/base/${cAddr}`,
          });
        }
      } catch {
        // Skip incompatible contracts
      }
    }
  } catch (err) {
    console.error("On-chain portfolio check error:", err);
  }

  return {
    walletAddress,
    items,
    totalNfts: items.reduce((acc, item) => {
      // Extract count if stored in token string or default to 1 per item
      return acc + 1;
    }, 0),
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
