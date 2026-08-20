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

// Live background activity poller to copy-mint tracked whale actions on Base
export async function pollTrackedWalletsForUser(telegramId: bigint, notifyCallback: (msg: string) => void) {
  const config = await getSniperConfig(telegramId);
  if (!config.autoCopy) return;

  const tracked = await getTrackedWallets(telegramId);
  if (tracked.length === 0) return;

  const publicClient = getPublicClient();

  for (const tw of tracked) {
    try {
      // Get the latest block number on Base
      const blockNumber = await publicClient.getBlockNumber();
      const block = await publicClient.getBlock({ blockNumber, includeTransactions: true });

      if (!block || !block.transactions) continue;

      for (const tx of block.transactions) {
        if (typeof tx === "object" && tx.from && tx.from.toLowerCase() === tw.address.toLowerCase()) {
          // Whale interacted with a contract! Check if it looks like a mint call (data length > 10)
          if (tx.to && tx.input && tx.input !== "0x" && tx.input.length > 10) {
            const valueEth = Number(tx.value || 0n) / 1e18;

            // Enforce user max spend filter
            if (valueEth <= config.maxSpendEth) {
              notifyCallback(
                `🎯 **Whale Alert (${tw.label || "Tracked"})!**\n` +
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
    } catch (err) {
      console.error(`Error polling tracked wallet ${tw.address}:`, err);
    }
  }
}
