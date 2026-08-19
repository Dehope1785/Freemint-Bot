import { type Address, type Hex, parseAbi, encodeFunctionData } from "viem";
import { prisma } from "../db/client.js";
import { getWalletClient, getPublicClient, BASE_CHAIN_ID } from "./chain.js";
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
}

export interface BatchMintResult {
  contractAddress: string;
  results: MintResult[];
  totalSuccess: number;
  totalFailed: number;
}

export async function executeMintForWallet(
  walletId: string,
  walletAddress: string,
  label: string,
  contractAddress: string,
  mintFunction: MintFunctionInfo,
  userId: bigint
): Promise<MintResult> {
  const privateKey = (await getWalletPrivateKey(walletId)) as Hex;
  const walletClient = getWalletClient(privateKey);
  const publicClient = getPublicClient();

  try {
    const abiItem = parseAbi([
      `function ${mintFunction.name}(${mintFunction.args.join(",")})`,
    ] as const);

    // Build args: if function takes uint256, pass 1n (mint 1 token)
    const args: unknown[] = mintFunction.args.length === 1 ? [1n] : [];

    // Simulate first to prevent burning gas on reverted calls
    const simResult = await simulateMint(contractAddress, walletAddress, mintFunction);
    if (!simResult.success) {
      await recordMintHistory(userId, contractAddress, null, "SIMULATION_FAILED");
      return {
        walletId,
        walletAddress,
        label,
        success: false,
        error: `Simulation failed: ${simResult.error}`,
      };
    }

    // Encode the function data
    const data = encodeFunctionData({
      abi: abiItem,
      functionName: mintFunction.name,
      args: args as any,
    });

    // Send transaction with value === 0n
    const txHash = await walletClient.sendTransaction({
      to: contractAddress as Address,
      data,
      value: 0n,
      chain: undefined, // use client's chain
      account: walletClient.account!,
    });

    // Wait for receipt
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    const status = receipt.status === "success" ? "SUCCESS" : "FAILED";
    await recordMintHistory(userId, contractAddress, txHash, status);

    return {
      walletId,
      walletAddress,
      label,
      success: receipt.status === "success",
      txHash,
      basescanUrl: `https://basescan.org/tx/${txHash}`,
      error: receipt.status !== "success" ? "Transaction reverted on-chain" : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordMintHistory(userId, contractAddress, null, "ERROR");
    return {
      walletId,
      walletAddress,
      label,
      success: false,
      error: message,
    };
  }
}

export async function batchMint(
  userId: bigint,
  contractAddress: string
): Promise<BatchMintResult> {
  // Scan the contract first
  const scanResult = await scanContract(contractAddress);

  if (!scanResult.isContract) {
    return {
      contractAddress,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
    };
  }

  if (scanResult.mintFunctions.length === 0) {
    return {
      contractAddress,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
    };
  }

  // Check for paid functions - abort if no free mints
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

  // Get all active wallets
  const activeWallets = await getActiveWallets(userId);
  if (activeWallets.length === 0) {
    return {
      contractAddress,
      results: [],
      totalSuccess: 0,
      totalFailed: 0,
    };
  }

  // Execute concurrently across all active wallets
  const results = await Promise.all(
    activeWallets.map((w) =>
      executeMintForWallet(w.id, w.address, w.label, contractAddress, mintFunction, userId)
    )
  );

  const totalSuccess = results.filter((r) => r.success).length;
  const totalFailed = results.filter((r) => !r.success).length;

  return {
    contractAddress,
    results,
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
  await prisma.mintHistory.create({
    data: {
      userId,
      contractAddress,
      txHash,
      status,
    },
  });
}

export async function getMintHistory(userId: bigint, limit = 10) {
  return prisma.mintHistory.findMany({
    where: { userId },
    orderBy: { timestamp: "desc" },
    take: limit,
  });
}
