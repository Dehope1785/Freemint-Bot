import { type Address, type Hex, parseAbi, encodeFunctionData } from "viem";
import { prisma } from "../db/client.js";
import { getWalletClient, getPublicClient } from "./chain.js";
import { getActiveWallets, getWalletPrivateKey } from "./wallet.js";
import { scanContract, getBestMintFunction, simulateMint, type MintFunctionInfo } from "./scanner.js";

export interface MintResult {
  walletId: string;
  walletAddress: string;
  label: string;
  success: boolean;
  txHash?: string;
  error?: string;
  basescanUrl?: string;
  iteration?: number;
}

export interface BatchMintResult {
  contractAddress: string;
  results: MintResult[];
  totalSuccess: number;
  totalFailed: number;
}

// In-memory quantity multiplier per user (defaults to 1x)
const userMintQuantities = new Map<bigint, number>();

export function getUserMintQuantity(userId: bigint): number {
  return userMintQuantities.get(userId) ?? 1;
}

export function setUserMintQuantity(userId: bigint, quantity: number): void {
  userMintQuantities.set(userId, Math.max(1, Math.min(quantity, 10)));
}

export async function executeMintForWallet(
  walletId: string,
  walletAddress: string,
  label: string,
  contractAddress: string,
  mintFunction: MintFunctionInfo,
  userId: bigint,
  iteration: number = 1
): Promise<MintResult> {
  const privateKey = (await getWalletPrivateKey(walletId)) as Hex;
  const walletClient = getWalletClient(privateKey);
  const publicClient = getPublicClient();
  const iterLabel = iteration > 1 ? `${label} (Mint #${iteration})` : label;

  try {
    const abiItem = parseAbi([
      `function ${mintFunction.name}(${mintFunction.args.join(",")})`,
    ] as const);

    const args: unknown[] = mintFunction.args.length === 1 ? [1n] : [];

    // Simulate first to prevent burning gas on reverted calls
    const simResult = await simulateMint(contractAddress, walletAddress, mintFunction);
    if (!simResult.success) {
      await recordMintHistory(userId, contractAddress, null, "SIMULATION_FAILED");
      return {
        walletId,
        walletAddress,
        label: iterLabel,
        success: false,
        error: `Simulation failed: ${simResult.error}`,
        iteration,
      };
    }

    const data = encodeFunctionData({
      abi: abiItem,
      functionName: mintFunction.name,
      args: args as any,
    });

    const txHash = await walletClient.sendTransaction({
      to: contractAddress as Address,
      data,
      value: 0n,
      chain: undefined,
      account: walletClient.account!,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    const status = receipt.status === "success" ? "SUCCESS" : "FAILED";
    await recordMintHistory(userId, contractAddress, txHash, status);

    return {
      walletId,
      walletAddress,
      label: iterLabel,
      success: receipt.status === "success",
      txHash,
      basescanUrl: `https://basescan.org/tx/${txHash}`,
      error: receipt.status !== "success" ? "Transaction reverted on-chain" : undefined,
      iteration,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordMintHistory(userId, contractAddress, null, "ERROR");
    return {
      walletId,
      walletAddress,
      label: iterLabel,
      success: false,
      error: message,
      iteration,
    };
  }
}

export async function batchMint(
  userId: bigint,
  contractAddress: string
): Promise<BatchMintResult> {
  const scanResult = await scanContract(contractAddress);

  if (!scanResult.isContract || scanResult.mintFunctions.length === 0) {
    return {
      contractAddress,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
    };
  }

  const freeMints = scanResult.mintFunctions.filter((f) => f.isFreeMint && !f.requiresPayment);
  if (freeMints.length === 0) {
    return {
      contractAddress,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
    };
  }

  const mintFunction = getBestMintFunction(freeMints);
  if (!mintFunction) {
    return {
      contractAddress,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
    };
  }

  const activeWallets = await getActiveWallets(userId);
  if (activeWallets.length === 0) {
    return {
      contractAddress,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
    };
  }

  const rounds = getUserMintQuantity(userId);
  const allResults: MintResult[] = [];

  for (const w of activeWallets) {
    for (let round = 1; round <= rounds; round++) {
      const res = await executeMintForWallet(
        w.id,
        w.address,
        w.label,
        contractAddress,
        mintFunction,
        userId,
        round
      );
      allResults.push(res);

      // If a wallet fails due to max allocation, break loop for this wallet
      if (!res.success) {
        break;
      }
    }
  }

  const totalSuccess = allResults.filter((r) => r.success).length;
  const totalFailed = allResults.filter((r) => !r.success).length;

  return {
    contractAddress,
    results: allResults,
    totalSuccess,
    totalFailed,
  };
}

export async function manualMint(
  userId: bigint,
  contractAddress: string
): Promise<BatchMintResult> {
  return batchMint(userId, contractAddress);
}

async function recordMintHistory(
  userId: bigint,
  contractAddress: string,
  txHash: string | null,
  status: string
): Promise<void> {
  try {
    await prisma.mintHistory.create({
      data: {
        userId,
        contractAddress,
        txHash,
        status,
      },
    });
  } catch (err) {
    console.error("Failed to record mint history:", err);
  }
}

export async function getMintHistory(userId: bigint, limit = 10) {
  return prisma.mintHistory.findMany({
    where: { userId },
    orderBy: { timestamp: "desc" },
    take: limit,
  });
}
