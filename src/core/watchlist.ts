import { prisma } from "../db/client.js";

export async function addToWatchlist(userId: bigint, contractAddress: string) {
  const normalized = contractAddress.toLowerCase();
  return prisma.watchlist.upsert({
    where: {
      userId_contractAddress: { userId, contractAddress: normalized },
    },
    update: {},
    create: { userId, contractAddress: normalized },
  });
}

export async function removeFromWatchlist(userId: bigint, contractAddress: string) {
  const normalized = contractAddress.toLowerCase();
  return prisma.watchlist.deleteMany({
    where: { userId, contractAddress: normalized },
  });
}

export async function getWatchlist(userId: bigint) {
  return prisma.watchlist.findMany({
    where: { userId },
    orderBy: { addedAt: "desc" },
  });
}

export async function isInWatchlist(userId: bigint, contractAddress: string): Promise<boolean> {
  const normalized = contractAddress.toLowerCase();
  const item = await prisma.watchlist.findUnique({
    where: {
      userId_contractAddress: { userId, contractAddress: normalized },
    },
  });
  return item !== null;
}

export async function getAutoMintUsers() {
  return prisma.user.findMany({
    where: { autoMintEnabled: true },
  });
}

export async function setAutoMintEnabled(telegramId: bigint, enabled: boolean) {
  await prisma.user.upsert({
    where: { telegramId },
    update: { autoMintEnabled: enabled },
    create: { telegramId, autoMintEnabled: enabled },
  });
}

export async function getAutoMintStatus(telegramId: bigint): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { telegramId } });
  return user?.autoMintEnabled ?? false;
}

export async function getWatchlistWithContracts(userId: bigint) {
  const items = await getWatchlist(userId);
  return items.map((w) => w.contractAddress);
}
