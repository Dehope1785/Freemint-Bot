import "dotenv/config";
import { createBot } from "./bot/index.js";
import { startHealthServer } from "./server/health.js";
import { startAutoMintLoop } from "./core/autoMint.js";
import { prisma } from "./db/client.js";

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

  // Create and start the bot
  const bot = createBot();

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

  // Start health check server for Railway
  startHealthServer(bot);

  // Start auto-mint polling loop
  startAutoMintLoop(bot);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("🛑 Shutting down...");
    await bot.stop();
    await prisma.$disconnect();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("🛑 Shutting down (SIGTERM)...");
    await bot.stop();
    await prisma.$disconnect();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
