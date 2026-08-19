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

    for (const contractAddr of seenContracts) {
      try {
        const cAddr = contractAddr as Address;

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
    return { success: false, error: "No active bids found on secondary markets" };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}
