import { getAddress } from "viem";

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
