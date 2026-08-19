import { type Address } from "viem";
import { getPublicClient } from "./chain.js";
import { prisma } from "../db/client.js";

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

// Background checker function to monitor tracked wallets on Base
export async function checkTrackedWalletsActivity(telegramId: bigint) {
  const tracked = await getTrackedWallets(telegramId);
  if (tracked.length === 0) return [];

  const publicClient = getPublicClient();
  const alerts: Array<{ address: string; label: string | null; message: string }> = [];

  for (const tw of tracked) {
    try {
      // Verify smart contract / account status on Base
      const code = await publicClient.getBytecode({ address: tw.address as Address });
      if (code) {
        // Tracked address is active on-chain
        // You can extend this to check recent logs/transactions using publicClient.getLogs()
      }
    } catch (err) {
      console.error(`Error checking tracked wallet ${tw.address}:`, err);
    }
  }

  return alerts;
}
