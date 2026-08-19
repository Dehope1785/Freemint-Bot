import "dotenv/config";
import { createBot } from "./bot/index.js";
import { startHealthServer } from "./server/health.js";
import { startAutoMintLoop } from "./core/autoMint.js";
import { prisma } from "./db/client.js";
import { BaseDropListener } from "./core/listener.js";
import { scanContract } from "./core/scanner.js";

async function main() {
  console.log("🚀 Starting Base Auto-Mint Bot...");

  // Validate required environment variables
  const required = ["BOT_TOKEN", "ENCRYPTION_KEY"];
  for (const key of required) {
    if (!process.env[key]) {
      console.error(`❌ Missing required environment variable: ${key}`);
      process.exit(1);
    }
  }

  // Test database connection
  try {
    await prisma.$connect();
    console.log("✅ Database connected");
  } catch (error) {
    console.error("❌ Database connection failed:", error);
    process.exit(1);
  }

  // Create bot instance
  const bot = createBot();

  // Start health check server
  startHealthServer(bot);

  // Start auto-mint polling loop
  startAutoMintLoop(bot);

  // 📡 Real-Time Free-Mint Auto-Discovery Block Sniffer
  const dropListener = new BaseDropListener(async (drop) => {
    try {
      const scan = await scanContract(drop.contractAddress);
      if (!scan.isContract || scan.mintFunctions.length === 0) return;

      const fn = scan.mintFunctions[0];
      const alertMessage =
        `🚨 *NEW FREE MINT DETECTED!*\n\n` +
        `📦 *Contract:* \`${scan.contractAddress}\`\n` +
        `⚙️ *Function:* \`${fn.name}\`\n` +
        `🔍 *Verified:* ${scan.isVerified ? "✅ Yes" : "⚠️ Bytecode"}\n\n` +
        `_Tap below to mint with your active wallets:_`;

      // Fetch users who have auto-mint enabled and have active wallets
      const activeUsers = await prisma.user.findMany({
        where: { autoMintEnabled: true },
        include: { wallets: { where: { isEnabled: true } } },
      });

      for (const user of activeUsers) {
        if (!user.wallets || user.wallets.length === 0) continue;

        await bot.api.sendMessage(Number(user.telegramId), alertMessage, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚀 Batch Mint Now", callback_data: `mint_${scan.contractAddress}` }],
              [{ text: "🔗 View on BaseScan", url: `https://basescan.org/address/${scan.contractAddress}` }],
            ],
          },
        }).catch((sendErr) => console.error(`Error alerting user ${user.telegramId}:`, sendErr));
      }
    } catch (err) {
      console.error("Auto-discovery pipeline error:", err);
    }
  });

  // Start listening to the Base blockchain
  dropListener.start();

  // Graceful shutdown handlers
  const handleShutdown = async (signal: string) => {
    console.log(`🛑 Shutting down (${signal})...`);
    dropListener.stop();
    await bot.stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));

  // Start grammY bot polling (runs persistently)
  try {
    await bot.start({
      onStart: (botInfo) => {
        console.log(`✅ Bot started: @${botInfo.username}`);
      },
    });
  } catch (error) {
    console.error("❌ Failed to start bot:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
