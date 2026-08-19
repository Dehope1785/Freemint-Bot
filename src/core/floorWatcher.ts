import { type Bot } from "grammy";
import { prisma } from "../db/client.js";
import { fetchWalletPortfolio } from "./portfolio.js";
import { shortenAddress } from "./chain.js";

// Stores known floor prices per token (key: `${contract}:${tokenId}`)
const knownFloors = new Map<string, number>();

export function startFloorWatcher(bot: Bot<any>, intervalSeconds: number = 300) {
  console.log(`📈 NFT Floor Price & Bid Watcher active (interval: ${intervalSeconds}s)...`);

  const runCheck = async () => {
    try {
      // Find all registered users with wallets
      const users = (await (prisma as any).user.findMany({
        include: { wallets: true },
      })) as Array<any>;

      for (const user of users) {
        if (!user.wallets || user.wallets.length === 0) continue;

        const targetChatId = typeof user.telegramId === "bigint" 
          ? Number(user.telegramId) 
          : user.telegramId;

        for (const wallet of user.wallets) {
          const portfolio = await fetchWalletPortfolio(wallet.address);
          if (portfolio.items.length === 0) continue;

          for (const item of portfolio.items) {
            const tokenKey = `${item.contractAddress.toLowerCase()}:${item.tokenId}`;
            const lastFloor = knownFloors.get(tokenKey) ?? 0;
            const currentFloor = item.floorPriceEth;
            const currentBid = item.topBidEth;

            // Trigger alert if a floor price or bid is detected for the first time or increases
            if (currentFloor > 0 && currentFloor > lastFloor) {
              knownFloors.set(tokenKey, currentFloor);

              const alertMsg =
                `🔥 *NFT VALUE DETECTED!*\n\n` +
                `🎨 *Collection:* ${item.collectionName}\n` +
                `🔢 *Token ID:* \`#${item.tokenId}\`\n` +
                `👛 *Wallet:* ${wallet.label} (\`${shortenAddress(wallet.address)}\`)\n\n` +
                `💎 *Current Floor Price:* \`${currentFloor} ETH\`\n` +
                `💰 *Top Instant Bid:* \`${currentBid > 0 ? `${currentBid} ETH` : "None"}\`\n\n` +
                `_Your minted NFT now has active market liquidity!_`;

              await bot.api.sendMessage(targetChatId, alertMsg, {
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [
                    [
                      { 
                        text: `💰 Instant Sell #${item.tokenId}`, 
                        callback_data: `sell_${item.contractAddress}_${item.tokenId}_${wallet.id}` 
                      }
                    ],
                    [
                      { text: "🔗 View on OpenSea", url: item.openseaUrl }
                    ]
                  ],
                },
              }).catch((sendErr) => console.error(`Floor alert send error:`, sendErr));
            } else if (currentFloor > 0) {
              knownFloors.set(tokenKey, currentFloor);
            }
          }
        }
      }
    } catch (err) {
      console.error("Floor watcher cycle error:", err);
    }
  };

  // Initial run after 15 seconds, then repeat on interval
  setTimeout(runCheck, 15_000);
  setInterval(runCheck, intervalSeconds * 1000);
}
