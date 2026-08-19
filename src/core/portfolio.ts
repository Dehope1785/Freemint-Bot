import { type Hex, createWalletClient, http, parseAbi, type Address } from "viem";
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

  try {
    // 1. Fetch all successful mint history records from the database
    const history = await prisma.mintHistory.findMany({
      where: { status: "SUCCESS", txHash: { not: null } },
      orderBy: { timestamp: "desc" },
      take: 25,
    });

    const uniqueContracts = Array.from(new Set(history.map((h) => h.contractAddress)));

    // 2. Check balance and query token IDs for each contract
    for (const contractAddr of uniqueContracts) {
      try {
        const cAddr = contractAddr as Address;

        // Check ERC-721 balance for this wallet
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
          let collectionName = `Contract ${cAddr.slice(0, 6)}...`;
          try {
            const nameResult = (await publicClient.readContract({
              address: cAddr,
              abi: parseAbi(["function name() view returns (string)"]),
              functionName: "name",
            })) as string;
            if (nameResult) collectionName = nameResult;
          } catch {
            // Default name if contract doesn't implement name()
          }

          // Add an entry representing the tokens held in this contract
          items.push({
            contractAddress: cAddr,
            tokenId: `x${balance.toString()}`,
            collectionName: `${collectionName} (${balance.toString()} held)`,
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

  // 3. Fallback to Reservoir API if database history check found nothing
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
    } catch {
      // Ignore fallback network errors
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
