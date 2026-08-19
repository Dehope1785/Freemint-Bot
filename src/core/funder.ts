import { 
  createWalletClient, 
  http, 
  type Hex, 
  getAddress, 
  parseEther 
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getPublicClient } from "./chain.js";
import { getWallets, getWalletPrivateKey } from "./wallet.js";

export interface FundResult {
  walletLabel: string;
  toAddress: string;
  fundedEth: number;
  txHash?: string;
  error?: string;
}

export async function fundSubWallets(
  userId: bigint,
  amountPerWalletEth: number
): Promise<{ totalDistributedEth: number; results: FundResult[] }> {
  const publicClient = getPublicClient();
  const wallets = await getWallets(userId);

  if (wallets.length < 2) {
    throw new Error("You need at least 2 wallets (1 Master + sub-wallets) to distribute funds.");
  }

  const masterWallet = wallets[0];
  const subWallets = wallets.slice(1);

  const privateKey = await getWalletPrivateKey(masterWallet.id);
  const hexKey = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
  const masterAccount = privateKeyToAccount(hexKey);

  const masterBalance = await publicClient.getBalance({ address: masterAccount.address });
  const sendWei = parseEther(amountPerWalletEth.toString());
  const totalNeededWei = sendWei * BigInt(subWallets.length);

  if (masterBalance < totalNeededWei) {
    throw new Error(
      `Insufficient balance in ${masterWallet.label}. Required: ${(Number(totalNeededWei) / 1e18).toFixed(5)} ETH | Available: ${(Number(masterBalance) / 1e18).toFixed(5)} ETH`
    );
  }

  const walletClient = createWalletClient({
    account: masterAccount,
    chain: base,
    transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org"),
  });

  const results: FundResult[] = [];
  let totalDistributedEth = 0;

  for (const target of subWallets) {
    try {
      const txHash = await walletClient.sendTransaction({
        to: getAddress(target.address),
        value: sendWei,
      });

      await publicClient.waitForTransactionReceipt({ hash: txHash });

      totalDistributedEth += amountPerWalletEth;
      results.push({
        walletLabel: target.label,
        toAddress: target.address,
        fundedEth: amountPerWalletEth,
        txHash,
      });
    } catch (err) {
      results.push({
        walletLabel: target.label,
        toAddress: target.address,
        fundedEth: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { totalDistributedEth, results };
}
