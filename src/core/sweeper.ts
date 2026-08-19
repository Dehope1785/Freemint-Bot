import { 
  createWalletClient, 
  http, 
  type Hex, 
  getAddress, 
  parseGwei 
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { getPublicClient } from "./chain.js";
import { getWallets, getWalletPrivateKey } from "./wallet.js";

export interface SweepResult {
  walletLabel: string;
  fromAddress: string;
  sweptEth: number;
  txHash?: string;
  error?: string;
}

export async function sweepDustToMaster(
  userId: bigint,
  destinationAddress: string
): Promise<{ totalSweptEth: number; results: SweepResult[] }> {
  const publicClient = getPublicClient();
  const wallets = await getWallets(userId);
  const cleanDestination = getAddress(destinationAddress);

  const results: SweepResult[] = [];
  let totalSweptEth = 0;

  for (const w of wallets) {
    // Skip if this wallet is the destination
    if (getAddress(w.address).toLowerCase() === cleanDestination.toLowerCase()) {
      continue;
    }

    try {
      const balance = await publicClient.getBalance({ address: getAddress(w.address) });
      if (balance === 0n) {
        results.push({
          walletLabel: w.label,
          fromAddress: w.address,
          sweptEth: 0,
          error: "0 balance",
        });
        continue;
      }

      const privateKey = await getWalletPrivateKey(w.id);
      const hexKey = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
      const account = privateKeyToAccount(hexKey);

      const walletClient = createWalletClient({
        account,
        chain: base,
        transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org"),
      });

      // Gas calculation for native Base transfer (21000 standard gas)
      const gasPrice = await publicClient.getGasPrice();
      const gasCost = 21000n * gasPrice;

      if (balance <= gasCost) {
        results.push({
          walletLabel: w.label,
          fromAddress: w.address,
          sweptEth: 0,
          error: "Balance insufficient for gas",
        });
        continue;
      }

      const sendAmount = balance - gasCost;

      const txHash = await walletClient.sendTransaction({
        to: cleanDestination,
        value: sendAmount,
      });

      await publicClient.waitForTransactionReceipt({ hash: txHash });

      const ethValue = Number(sendAmount) / 1e18;
      totalSweptEth += ethValue;

      results.push({
        walletLabel: w.label,
        fromAddress: w.address,
        sweptEth: ethValue,
        txHash,
      });
    } catch (err) {
      results.push({
        walletLabel: w.label,
        fromAddress: w.address,
        sweptEth: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { totalSweptEth, results };
}
