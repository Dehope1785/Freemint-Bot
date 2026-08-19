import { 
  type Address, 
  type Hex, 
  getAddress, 
  parseAbi, 
  createWalletClient, 
  http 
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getPublicClient } from "./chain.js";

export interface NFTItem {
  contractAddress: string;
  tokenId: string;
  collectionName: string;
  floorPriceEth: number;
  topBidEth: number;
  openseaUrl: string;
}

export interface WalletPortfolio {
  address: string;
  totalNfts: number;
  totalFloorValueEth: number;
  items: NFTItem[];
}

export interface SellQuote {
  hasBid: boolean;
  priceEth: number;
  marketName: string;
  orderId?: string;
  routerAddress?: Address;
  calldata?: Hex;
  value?: bigint;
}

const APPROVAL_ABI = parseAbi([
  "function setApprovalForAll(address operator, bool approved) external",
  "function isApprovedForAll(address owner, address operator) external view returns (bool)"
]);

// Fetches all ERC-721 / ERC-1155 tokens held by a wallet on Base
export async function fetchWalletPortfolio(walletAddress: string): Promise<WalletPortfolio> {
  const cleanAddr = getAddress(walletAddress);
  const url = `https://api-base.reservoir.tools/users/${cleanAddr}/tokens/v7?limit=20`;

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    const data = (await res.json()) as any;

    if (!data || !data.tokens) {
      return { address: cleanAddr, totalNfts: 0, totalFloorValueEth: 0, items: [] };
    }

    const items: NFTItem[] = data.tokens.map((entry: any) => {
      const token = entry.token;
      const floor = token.collection?.floorAsk?.price?.amount?.native || 0;
      const topBid = token.collection?.topBid?.price?.amount?.native || 0;

      return {
        contractAddress: token.contract,
        tokenId: token.tokenId,
        collectionName: token.collection?.name || "Unnamed NFT",
        floorPriceEth: floor,
        topBidEth: topBid,
        openseaUrl: `https://opensea.io/assets/base/${token.contract}/${token.tokenId}`,
      };
    });

    const totalFloorValueEth = items.reduce((acc, curr) => acc + curr.floorPriceEth, 0);

    return {
      address: cleanAddr,
      totalNfts: items.length,
      totalFloorValueEth,
      items,
    };
  } catch (error) {
    console.error(`Error fetching portfolio for ${walletAddress}:`, error);
    return { address: cleanAddr, totalNfts: 0, totalFloorValueEth: 0, items: [] };
  }
}

// Fetch the best instant-sell route for a specific NFT
export async function getBestSellQuote(
  contractAddress: string,
  tokenId: string,
  makerAddress: string
): Promise<SellQuote> {
  const cleanAddr = getAddress(contractAddress);
  const cleanMaker = getAddress(makerAddress);

  const url = `https://api-base.reservoir.tools/execute/sell/v7`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: `${cleanAddr}:${tokenId}`,
        taker: cleanMaker,
        exactAmount: 1
      }),
    });
    const data = (await res.json()) as any;

    if (!data.steps || data.steps.length === 0) {
      return { hasBid: false, priceEth: 0, marketName: "None" };
    }

    const saleStep = data.steps.find((s: any) => s.id === "sale" || s.kind === "transaction");
    if (!saleStep || !saleStep.items || saleStep.items.length === 0) {
      return { hasBid: false, priceEth: 0, marketName: "None" };
    }

    const txItem = saleStep.items[0].data;
    const priceEth = data.path?.[0]?.quote || 0;
    const sourceName = data.path?.[0]?.source || "Secondary Market";

    return {
      hasBid: true,
      priceEth,
      marketName: sourceName,
      routerAddress: getAddress(txItem.to),
      calldata: txItem.data as Hex,
      value: BigInt(txItem.value || 0),
    };
  } catch (error) {
    console.error("Sell quote fetch error:", error);
    return { hasBid: false, priceEth: 0, marketName: "None" };
  }
}

// Execute the sell transaction on-chain
export async function executeSell(
  privateKey: Hex,
  contractAddress: string,
  tokenId: string
): Promise<{ success: boolean; txHash?: string; error?: string; payoutEth?: number }> {
  const account = privateKeyToAccount(privateKey);
  const publicClient = getPublicClient();

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org"),
  });

  try {
    const quote = await getBestSellQuote(contractAddress, tokenId, account.address);
    if (!quote.hasBid || !quote.routerAddress || !quote.calldata) {
      return { success: false, error: "No active bids available to fill for this NFT on secondary markets." };
    }

    // Check & submit setApprovalForAll if needed
    const isApproved = await publicClient.readContract({
      address: getAddress(contractAddress),
      abi: APPROVAL_ABI,
      functionName: "isApprovedForAll",
      args: [account.address, quote.routerAddress],
    });

    if (!isApproved) {
      const approveTx = await walletClient.writeContract({
        address: getAddress(contractAddress),
        abi: APPROVAL_ABI,
        functionName: "setApprovalForAll",
        args: [quote.routerAddress, true],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });
    }

    // Execute the fill transaction
    const txHash = await walletClient.sendTransaction({
      to: quote.routerAddress,
      data: quote.calldata,
      value: quote.value || 0n,
    });

    await publicClient.waitForTransactionReceipt({ hash: txHash });

    return { success: true, txHash, payoutEth: quote.priceEth };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
