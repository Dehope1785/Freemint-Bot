import { randomBytes } from "crypto";
import { prisma } from "../db/client.js";
import { encrypt, decrypt } from "./crypto.js";
import {
  getWalletClient,
  getAddressFromPrivateKey,
  isValidPrivateKey,
  normalizePrivateKey,
  normalizeAddress,
  type Hex,
} from "./chain.js";

export interface WalletInfo {
  id: string;
  address: string;
  label: string;
  isActive: boolean;
}

export async function ensureUser(telegramId: bigint) {
  await prisma.user.upsert({
    where: { telegramId },
    update: {},
    create: { telegramId },
  });
}

export async function generateNewWallet(telegramId: bigint, label?: string): Promise<WalletInfo> {
  await ensureUser(telegramId);
  const privateKey = `0x${randomBytes(32).toString("hex")}` as Hex;
  const address = getAddressFromPrivateKey(privateKey);
  const encrypted = encrypt(privateKey);

  const wallet = await prisma.wallet.create({
    data: {
      userId: telegramId,
      address: normalizeAddress(address),
      encryptedPrivateKey: encrypted,
      label: label || `W${await getWalletCount(telegramId)}`,
      isActive: true,
    },
  });

  return {
    id: wallet.id,
    address: wallet.address,
    label: wallet.label,
    isActive: wallet.isActive,
  };
}

export async function importWallet(telegramId: bigint, privateKey: string, label?: string): Promise<WalletInfo> {
  await ensureUser(telegramId);

  if (!isValidPrivateKey(privateKey)) {
    throw new Error("Invalid private key format. Expected 64 hex characters (with or without 0x prefix).");
  }

  const normalizedKey = normalizePrivateKey(privateKey);
  const address = getAddressFromPrivateKey(normalizedKey);
  const normalizedAddr = normalizeAddress(address);

  // Check for duplicate
  const existing = await prisma.wallet.findFirst({
    where: { userId: telegramId, address: normalizedAddr },
  });
  if (existing) {
    throw new Error("This wallet is already imported.");
  }

  const encrypted = encrypt(normalizedKey);
  const wallet = await prisma.wallet.create({
    data: {
      userId: telegramId,
      address: normalizedAddr,
      encryptedPrivateKey: encrypted,
      label: label || `W${await getWalletCount(telegramId)}`,
      isActive: true,
    },
  });

  return {
    id: wallet.id,
    address: wallet.address,
    label: wallet.label,
    isActive: wallet.isActive,
  };
}

export async function getWallets(telegramId: bigint): Promise<WalletInfo[]> {
  const wallets = await prisma.wallet.findMany({
    where: { userId: telegramId },
    orderBy: { createdAt: "asc" },
  });
  return wallets.map((w) => ({
    id: w.id,
    address: w.address,
    label: w.label,
    isActive: w.isActive,
  }));
}

export async function getActiveWallets(telegramId: bigint): Promise<WalletInfo[]> {
  const wallets = await prisma.wallet.findMany({
    where: { userId: telegramId, isActive: true },
    orderBy: { createdAt: "asc" },
  });
  return wallets.map((w) => ({
    id: w.id,
    address: w.address,
    label: w.label,
    isActive: w.isActive,
  }));
}

export async function toggleWallet(walletId: string): Promise<WalletInfo | null> {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) return null;
  const updated = await prisma.wallet.update({
    where: { id: walletId },
    data: { isActive: !wallet.isActive },
  });
  return {
    id: updated.id,
    address: updated.address,
    label: updated.label,
    isActive: updated.isActive,
  };
}

export async function deleteWallet(walletId: string): Promise<boolean> {
  const result = await prisma.wallet.deleteMany({ where: { id: walletId } });
  return result.count > 0;
}

export async function getWalletPrivateKey(walletId: string): Promise<string> {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) throw new Error("Wallet not found.");
  return decrypt(wallet.encryptedPrivateKey);
}

export async function getWalletById(walletId: string) {
  return prisma.wallet.findUnique({ where: { id: walletId } });
}

async function getWalletCount(telegramId: bigint): Promise<number> {
  return prisma.wallet.count({ where: { userId: telegramId } });
}
