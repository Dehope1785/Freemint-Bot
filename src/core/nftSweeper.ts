import { 
  type Hex, 
  getAddress, 
  parseAbi, 
  createWalletClient, 
  http 
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getPublicClient } from "./chain.js";
import { getWallets, getWalletPrivateKey } from "./wallet.js";
import { fetchWalletPortfolio } from "./portfolio.js";

const ERC721_ABI = parseAbi([
  "function transferFrom(address from, address to, uint256 tokenId) external",
  "function safeTransferFrom(address from, address to, uint256 tokenId) external"
]);

export interface NFTSweepResult {
  fromWallet: string;
  collectionName: string;
  tokenId: string;
  txHash?: string;
  error?: string;
}

export async function sweepAllNFTsToMaster(
  userId: bigint,
  destinationVault: string
): Promise<{ totalMoved: number; results: NFTSweepResult[] }> {
  const publicClient = getPublicClient();
  const wallets = await getWallets(userId);
  const cleanDestination = getAddress(destinationVault);

  if (wallets.length < 2) {
    throw new Error("You need at least 2 wallets to consolidate NFTs.");
  }

  const results: NFTSweepResult[] = [];
  let totalMoved = 0;

  // Loop through sub-wallets (skipping Wallet 1 vault)
  for (const w of wallets) {
    if (getAddress(w.address).toLowerCase() === cleanDestination.toLowerCase()) {
      continue;
    }

    try {
      const portfolio = await fetchWalletPortfolio(w.address);
      if (portfolio.items.length === 0) continue;

      const privateKey = await getWalletPrivateKey(w.id);
      const hexKey = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
      const account = privateKeyToAccount(hexKey);

      const walletClient = createWalletClient({
        account,
        chain: base,
        transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org"),
      });

      for (const item of portfolio.items) {
        try {
          const txHash = await walletClient.writeContract({
            address: getAddress(item.contractAddress),
            abi: ERC721_ABI,
            functionName: "transferFrom",
            args: [account.address, cleanDestination, BigInt(item.tokenId)],
          });

          await publicClient.waitForTransactionReceipt({ hash: txHash });

          totalMoved++;
          results.push({
            fromWallet: w.label,
            collectionName: item.collectionName,
            tokenId: item.tokenId,
            txHash,
          });
        } catch (nftErr) {
          results.push({
            fromWallet: w.label,
            collectionName: item.collectionName,
            tokenId: item.tokenId,
            error: nftErr instanceof Error ? nftErr.message : String(nftErr),
          });
        }
      }
    } catch (err) {
      console.error(`Error sweeping NFTs from ${w.label}:`, err);
    }
  }

  return { totalMoved, results };
}
