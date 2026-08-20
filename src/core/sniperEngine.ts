import { type Address, type Hex } from "viem";
import { getPublicClient } from "./chain.js";
import { prisma } from "../db/client.js";
import { batchMint } from "./mint.js";

export async function addTrackedWallet(telegramId: bigint, address: string, label?: string) {
  return await prisma.trackedWallet.upsert({
    where: { userId_address: { userId: telegramId, address: address.toLowerCase() } },
    update: { label },
    create: { userId: telegramId, address: address.toLowerCase(), label },
  });
}

export async function removeTrackedWallet(telegramId: bigint, address: string) {
  return await prisma.trackedWallet.deleteMany({
    where: { userId: telegramId, address: address.toLowerCase() },
  });
}

export async function getTrackedWallets(telegramId: bigint) {
  return await prisma.trackedWallet.findMany({
    where: { userId: telegramId },
  });
}

export async function getSniperConfig(telegramId: bigint) {
  let config = await prisma.sniperConfig.findUnique({
    where: { userId: telegramId },
  });

  if (!config) {
    config = await prisma.sniperConfig.create({
      data: { userId: telegramId, autoCopy: false, maxSpendEth: 0.0 },
    });
  }

  return config;
}

export async function setSniperConfig(telegramId: bigint, autoCopy: boolean, maxSpendEth: number) {
  return await prisma.sniperConfig.upsert({
    where: { userId: telegramId },
    update: { autoCopy, maxSpendEth },
    create: { userId: telegramId, autoCopy, maxSpendEth },
  });
}

// Keep track of the last scanned block per user to avoid skipping blocks
const lastScannedBlocks = new Map<string, bigint>();

// Live background activity poller to copy-mint tracked whale actions on Base
export async function pollTrackedWalletsForUser(telegramId: bigint, notifyCallback: (msg: string) => void) {
  const config = await getSniperConfig(telegramId);
  if (!config.autoCopy) return;

  const tracked = await getTrackedWallets(telegramId);
  if (tracked.length === 0) return;

  const publicClient = getPublicClient();

  try {
    const currentBlockNumber = await publicClient.getBlockNumber();
    const userKey = telegramId.toString();
    
    let lastBlock = lastScannedBlocks.get(userKey);
    if (!lastBlock) {
      // Initialize to current block minus 1 if first run
      lastBlock = currentBlockNumber - 1n;
    }

    // If new blocks have been minted, scan them sequentially
    if (currentBlockNumber > lastBlock) {
      for (let bNum = lastBlock + 1n; bNum <= currentBlockNumber; bNum++) {
        const block = await publicClient.getBlock({ blockNumber: bNum, includeTransactions: true });
        if (!block || !block.transactions) continue;

        for (const tx of block.transactions) {
          if (typeof tx === "object" && tx.from) {
            const sender = tx.from.toLowerCase();
            const matchedWallet = tracked.find(tw => tw.address.toLowerCase() === sender);

            if (matchedWallet) {
              // Whale made a transaction!
              if (tx.to && tx.input && tx.input !== "0x" && tx.input.length > 10) {
                const valueEth = Number(tx.value || 0n) / 1e18;

                // Enforce user max spend filter (e.g. 0 for strict free mints)
                if (valueEth <= config.maxSpendEth) {
                  notifyCallback(
                    `🎯 **Whale Alert (${matchedWallet.label || "Tracked"})!**\n` +
                    `Detected interaction with contract: \`${tx.to}\`\n` +
                    `Value: \`${valueEth} ETH\`\n\n` +
                    `🚀 Automatically triggering copy-mint across your active sub-wallets...`
                  );

                  // Execute the batch mint mirroring the contract
                  await batchMint(telegramId, tx.to);
                }
              }
            }
          }
        }
      }
      lastScannedBlocks.set(userKey, currentBlockNumber);
    }
  } catch (err) {
    console.error(`Error polling tracked wallets for user ${telegramId}:`, err);
  }
}
