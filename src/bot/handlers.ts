import { type Context, InlineKeyboard } from "grammy";
import { type Hex } from "viem";
import {
  generateNewWallet,
  importWallet,
  getWallets,
  toggleWallet,
  deleteWallet,
  getWalletPrivateKey,
  ensureUser,
  type WalletInfo,
} from "../core/wallet.js";
import {
  isValidAddress,
  isValidPrivateKey,
  shortenAddress,
  normalizeAddressInput,
} from "../core/chain.js";
import { scanContract } from "../core/scanner.js";
import { 
  batchMint, 
  getUserMintQuantity, 
  setUserMintQuantity 
} from "../core/mint.js";
import { 
  fetchWalletPortfolio, 
  executeSell 
} from "../core/portfolio.js";
import { sweepDustToMaster } from "../core/sweeper.js";
import { sweepAllNFTsToMaster } from "../core/nftSweeper.js";
import { fundSubWallets } from "../core/funder.js";
import { getEthUsdPrice, usdToEth } from "../core/price.js";
import { 
  checkGasSafety, 
  setUserGasCeiling 
} from "../core/gasGuard.js";
import {
  addToWatchlist,
  removeFromWatchlist,
  getWatchlist,
  setAutoMintEnabled,
  getAutoMintStatus,
} from "../core/watchlist.js";
import {
  mainMenuKeyboard,
  walletsKeyboard,
  deleteWalletKeyboard,
  exportWalletsKeyboard,
  watchlistKeyboard,
  confirmMintKeyboard,
  backToMainKeyboard,
  backToWalletsKeyboard,
  portfolioKeyboard,
  fundAmountKeyboard,
  settingsMenuKeyboard,
  gasSettingsKeyboard,
  quantitySettingsKeyboard,
} from "./keyboards.js";

interface SessionState {
  action: "import_key" | "scan" | "manual_mint" | "fund_custom" | "none";
  contractAddress?: string;
}

const sessions = new Map<bigint, SessionState>();

function getSession(userId: bigint): SessionState {
  if (!sessions.has(userId)) {
    sessions.set(userId, { action: "none" });
  }
  return sessions.get(userId)!;
}

function setSession(userId: bigint, state: SessionState) {
  sessions.set(userId, state);
}

function clearSession(userId: bigint) {
  sessions.set(userId, { action: "none" });
}

const MAIN_MENU_TEXT = `🤖 **Base Auto-Mint Bot**

Welcome! Manage your wallets, scan contracts, and auto-mint free NFTs on Base.

Select an option below:`;

export async function showMainMenu(ctx: Context) {
  const telegramId = BigInt(ctx.from!.id);
  const autoMint = await getAutoMintStatus(telegramId);
  await ctx.reply(MAIN_MENU_TEXT, {
    reply_markup: mainMenuKeyboard(autoMint),
    parse_mode: "Markdown",
  });
}

export async function startCommand(ctx: Context) {
  const telegramId = BigInt(ctx.from!.id);
  await ensureUser(telegramId);
  await showMainMenu(ctx);
}

export async function helpCommand(ctx: Context) {
  const text = `🛡 **Base Auto-Mint Bot — Help**

**Commands:**
/start — Show main menu
/help — Show this help

**Features:**
• 💼 Manage multiple wallets (generate, import, toggle, delete)
• 🔢 Mint Multiplier — Set 1x to 10x mints per wallet per drop
• ⛽ Gas Guard — Automatically blocks mints if Base L2 gas price surges
• ⛽ Refuel Gas — Distribute ETH from Wallet 1 to all sub-wallets
• 🧹 Sweep Dust — Consolidate left-over ETH from sub-wallets back to Wallet 1
• 📦 Sweep NFTs — Consolidate all minted NFTs into Wallet 1
• 🖼 Portfolio — View your minted NFTs, live floor prices, and instant-sell buttons
• 🔍 Scan any Base contract for free-mint functions
• ⚡ Auto-Mint — automatically detect and batch-mint drops on Base

**Security:**
• Private keys are encrypted with AES-256-GCM
• Exported keys are sent securely
• Only you can access your wallets

**Chain:** Base (Chain ID: 8453)`;

  await ctx.reply(text, {
    reply_markup: backToMainKeyboard(),
    parse_mode: "Markdown",
  });
}

export async function handleCallback(ctx: Context) {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const telegramId = BigInt(ctx.from!.id);
  await ctx.answerCallbackQuery();

  // Main menu
  if (data === "main_menu") {
    clearSession(telegramId);
    await ctx.editMessageText(MAIN_MENU_TEXT, {
      reply_markup: mainMenuKeyboard(await getAutoMintStatus(telegramId)),
      parse_mode: "Markdown",
    });
    return;
  }

  // Settings menu
  if (data === "settings") {
    clearSession(telegramId);
    await ctx.editMessageText(
      `🛡 **Bot Settings & Controls**\n\nConfigure quantity multipliers, gas limits, and preferences:`,
      {
        reply_markup: settingsMenuKeyboard(),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Multiplier menu
  if (data === "menu_mint_qty") {
    clearSession(telegramId);
    const currentQty = getUserMintQuantity(telegramId);
    await ctx.editMessageText(
      `🔢 **Mint Multiplier (Per Wallet)**\n\n` +
      `Current Setting: **${currentQty}x per wallet**\n\n` +
      `When a new free drop arrives, each active wallet will attempt to mint this many times.\n\n` +
      `Select your preferred multiplier:`,
      {
        reply_markup: quantitySettingsKeyboard(currentQty),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Set multiplier value
  if (data.startsWith("setqty_")) {
    const qty = parseInt(data.slice(7), 10);
    setUserMintQuantity(telegramId, qty);
    await ctx.editMessageText(
      `✅ Mint multiplier updated to **${qty}x per wallet**!`,
      {
        reply_markup: quantitySettingsKeyboard(qty),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Gas guard sub-menu
  if (data === "menu_gas_guard") {
    clearSession(telegramId);
    const gasCheck = await checkGasSafety(telegramId);
    await ctx.editMessageText(
      `⛽ **Gas Price Ceiling Guard**\n\n` +
      `Current Base Gas Price: \`${gasCheck.currentGwei.toFixed(4)} Gwei\`\n` +
      `Your Configured Ceiling: \`${gasCheck.maxGwei} Gwei\`\n\n` +
      `If the network gas exceeds your limit, mints will safely abort to avoid high fees.\n\n` +
      `Select your maximum gas ceiling:`,
      {
        reply_markup: gasSettingsKeyboard(gasCheck.maxGwei),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Set gas ceiling
  if (data.startsWith("setgas_")) {
    const val = parseFloat(data.slice(7));
    setUserGasCeiling(telegramId, val);
    await ctx.editMessageText(
      `✅ Gas ceiling updated to **${val} Gwei**!\n\nThe bot will skip mints if network gas rises above this level.`,
      {
        reply_markup: gasSettingsKeyboard(val),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Settings help text
  if (data === "menu_help_text") {
    clearSession(telegramId);
    await helpCommand(ctx);
    return;
  }

  // Portfolio screen
  if (data === "portfolio") {
    clearSession(telegramId);
    await showPortfolioScreen(ctx, telegramId);
    return;
  }

  // Sweep all NFTs to Wallet 1
  if (data === "sweep_nfts") {
    clearSession(telegramId);
    const wallets = await getWallets(telegramId);
    if (wallets.length < 2) {
      await ctx.reply("❌ You need at least 2 wallets to consolidate NFTs.", {
        reply_markup: backToWalletsKeyboard(),
      });
      return;
    }

    const masterVault = wallets[0].address;
    await ctx.reply(`📦 *Consolidating all sub-wallet NFTs into ${wallets[0].label} (\`${shortenAddress(masterVault)}\`)...*`, {
      parse_mode: "Markdown",
    });

    try {
      const sweep = await sweepAllNFTsToMaster(telegramId, masterVault);
      if (sweep.totalMoved === 0) {
        await ctx.reply("ℹ️ No NFTs found in sub-wallets to sweep.", {
          reply_markup: portfolioKeyboard(),
        });
        return;
      }

      let report = `✅ **NFT Consolidation Completed!**\n\n📦 **Total Moved:** \`${sweep.totalMoved} NFT(s)\`\n📥 **Destination:** \`${shortenAddress(masterVault)}\`\n\n`;

      for (const res of sweep.results) {
        if (res.txHash) {
          report += `• **${res.collectionName}** (#${res.tokenId}) from ${res.fromWallet} ([Tx](https://basescan.org/tx/${res.txHash}))\n`;
        } else {
          report += `• Failed #${res.tokenId} (${res.error})\n`;
        }
      }

      await ctx.reply(report, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
        reply_markup: portfolioKeyboard(),
      });
    } catch (err) {
      await ctx.reply(`❌ NFT sweep failed: ${errorMessage(err)}`, {
        reply_markup: portfolioKeyboard(),
      });
    }
    return;
  }

  // Instant sell execution
  if (data.startsWith("sell_")) {
    const parts = data.split("_");
    const contractAddr = parts[1];
    const tokenId = parts[2];
    const walletId = parts[3];

    await ctx.reply(`⚡ Checking liquidity & executing instant sell for token #${tokenId}...`);

    try {
      const privateKey = await getWalletPrivateKey(walletId);
      const hexKey = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;

      const result = await executeSell(hexKey, contractAddr, tokenId);

      if (result.success) {
        await ctx.reply(
          `🎉 **NFT SOLD SUCCESSFULLY!**\n\n` +
          `💰 Payout: \`${result.payoutEth} ETH\`\n` +
          `🔗 [View BaseScan Receipt](https://basescan.org/tx/${result.txHash})`,
          { parse_mode: "Markdown" }
        );
      } else {
        await ctx.reply(`❌ Instant sell failed: ${result.error || "No market bids available"}`);
      }
    } catch (err) {
      await ctx.reply(`❌ Sell execution failed: ${errorMessage(err)}`);
    }
    return;
  }

  // Gas funding menu
  if (data === "fund_menu") {
    clearSession(telegramId);
    const wallets = await getWallets(telegramId);
    if (wallets.length < 2) {
      await ctx.reply("❌ You need at least 2 wallets (Wallet 1 + sub-wallets) to distribute gas.", {
        reply_markup: backToWalletsKeyboard(),
      });
      return;
    }

    const ethPrice = await getEthUsdPrice();

    await ctx.editMessageText(
      `⛽ **Distribute Gas to All Sub-Wallets**\n\n` +
      `Master: **${wallets[0].label}** (\`${shortenAddress(wallets[0].address)}\`)\n` +
      `Target Recipients: **${wallets.length - 1} sub-wallets**\n` +
      `ETH/USD Price: **$${ethPrice.toLocaleString()}**\n\n` +
      `Select a preset or tap **Custom Amount**:`,
      {
        reply_markup: fundAmountKeyboard(ethPrice),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Custom fund amount prompt
  if (data === "fund_custom") {
    setSession(telegramId, { action: "fund_custom" });
    await ctx.editMessageText(
      `✍️ **Enter Custom Funding Amount**\n\n` +
      `Type the amount you want to send to each sub-wallet:\n\n` +
      `• In USD: e.g. \`$1.50\` or \`2 usd\`\n` +
      `• In ETH: e.g. \`0.0004 eth\``,
      {
        reply_markup: backToWalletsKeyboard(),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Fund preset execution
  if (data.startsWith("fund_")) {
    const amountStr = data.slice(5);
    const amountEth = parseFloat(amountStr);

    await ctx.reply(`🚀 *Distributing ${amountEth} ETH to each sub-wallet...*`, {
      parse_mode: "Markdown",
    });

    try {
      const fund = await fundSubWallets(telegramId, amountEth);
      let report = `✅ **Gas Distribution Completed!**\n\n💰 **Total Dispatched:** \`${fund.totalDistributedEth.toFixed(5)} ETH\`\n\n`;

      for (const res of fund.results) {
        if (res.txHash) {
          report += `• **${res.walletLabel}**: Funded \`${res.fundedEth} ETH\` ([Tx](https://basescan.org/tx/${res.txHash}))\n`;
        } else {
          report += `• **${res.walletLabel}**: Failed (${res.error})\n`;
        }
      }

      await ctx.reply(report, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
        reply_markup: backToWalletsKeyboard(),
      });
    } catch (err) {
      await ctx.reply(`❌ Distribution failed: ${errorMessage(err)}`, {
        reply_markup: backToWalletsKeyboard(),
      });
    }
    return;
  }

  // Wallets screen
  if (data === "wallets") {
    clearSession(telegramId);
    await showWalletsScreen(ctx, telegramId);
    return;
  }

  // Sweep ETH dust
  if (data === "sweep_dust") {
    clearSession(telegramId);
    const wallets = await getWallets(telegramId);
    if (wallets.length < 2) {
      await ctx.reply("❌ You need at least 2 wallets to consolidate funds.", {
        reply_markup: backToWalletsKeyboard(),
      });
      return;
    }

    const masterWallet = wallets[0].address;
    await ctx.reply(`🧹 *Consolidating all wallet balances into ${wallets[0].label} (\`${shortenAddress(masterWallet)}\`)...*`, {
      parse_mode: "Markdown",
    });

    try {
      const sweep = await sweepDustToMaster(telegramId, masterWallet);
      let report = `✅ **Sweep Completed!**\n\n💰 **Total Collected:** \`${sweep.totalSweptEth.toFixed(6)} ETH\`\n📥 **Destination:** \`${shortenAddress(masterWallet)}\`\n\n`;

      for (const res of sweep.results) {
        if (res.txHash) {
          report += `• **${res.walletLabel}**: Swept \`${res.sweptEth.toFixed(6)} ETH\` ([Tx](https://basescan.org/tx/${res.txHash}))\n`;
        } else if (res.error && res.error !== "0 balance") {
          report += `• **${res.walletLabel}**: Skipped (${res.error})\n`;
        }
      }

      await ctx.reply(report, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
        reply_markup: backToWalletsKeyboard(),
      });
    } catch (err) {
      await ctx.reply(`❌ Sweep failed: ${errorMessage(err)}`, {
        reply_markup: backToWalletsKeyboard(),
      });
    }
    return;
  }

  // New wallet
  if (data === "new_wallet") {
    clearSession(telegramId);
    try {
      const wallet = await generateNewWallet(telegramId);
      await ctx.reply(
        `✅ New wallet generated!\n\n📋 Label: ${wallet.label}\n📍 Address: \`${wallet.address}\`\n\nThis wallet is now active (✅) and ready to mint.`,
        { parse_mode: "Markdown", reply_markup: backToWalletsKeyboard() }
      );
    } catch (error) {
      await ctx.reply(`❌ Failed to generate wallet: ${errorMessage(error)}`, {
        reply_markup: backToMainKeyboard(),
      });
    }
    return;
  }

  // Import key
  if (data === "import_key") {
    setSession(telegramId, { action: "import_key" });
    await ctx.editMessageText(
      `📥 **Import Wallet by Private Key**\n\nPlease paste your private key directly in the chat.\n\nFormat: 64 hex characters (with or without 0x prefix)\n\n⚠️ Your key will be encrypted with AES-256-GCM before storage.`,
      { parse_mode: "Markdown", reply_markup: backToMainKeyboard() }
    );
    return;
  }

  // Export keys
  if (data === "export_keys") {
    clearSession(telegramId);
    await showExportScreen(ctx, telegramId);
    return;
  }

  // Delete wallet
  if (data === "delete_wallet") {
    clearSession(telegramId);
    await showDeleteScreen(ctx, telegramId);
    return;
  }

  // Toggle wallet
  if (data.startsWith("toggle_")) {
    const walletId = data.slice(7);
    const updated = await toggleWallet(walletId);
    if (updated) {
      await showWalletsScreen(ctx, telegramId);
    } else {
      await ctx.reply("❌ Wallet not found.", { reply_markup: backToWalletsKeyboard() });
    }
    return;
  }

  // Delete specific wallet
  if (data.startsWith("del_")) {
    const walletId = data.slice(4);
    const deleted = await deleteWallet(walletId);
    if (deleted) {
      await ctx.reply("✅ Wallet deleted successfully.", {
        reply_markup: backToWalletsKeyboard(),
      });
    } else {
      await ctx.reply("❌ Wallet not found.", { reply_markup: backToWalletsKeyboard() });
    }
    return;
  }

  // Export specific wallet key
  if (data.startsWith("export_")) {
    const walletId = data.slice(7);
    try {
      const privateKey = await getWalletPrivateKey(walletId);
      const wallets = await getWallets(telegramId);
      const wallet = wallets.find((w) => w.id === walletId);
      const label = wallet?.label || "Unknown";

      await ctx.reply(
        `🔑 **PRIVATE KEY**\n\nWallet: ${label}\nAddress: \`${wallet?.address || ""}\`\nPrivate Key: \`${privateKey}\`\n\n⚠️ Please delete this message manually after saving your key safely.`,
        { parse_mode: "Markdown" }
      );

      await ctx.reply("Saved your key? You can return to your wallets below:", {
        reply_markup: backToWalletsKeyboard(),
      });
    } catch (error) {
      await ctx.reply(`❌ Failed to export key: ${errorMessage(error)}`, {
        reply_markup: backToWalletsKeyboard(),
      });
    }
    return;
  }

  // Scan contract
  if (data === "scan_contract") {
    setSession(telegramId, { action: "scan" });
    await ctx.editMessageText(
      `🔍 **Scan Contract**\n\nPlease paste a contract address (0x...) directly in the chat to scan it for free-mint functions.`,
      { parse_mode: "Markdown", reply_markup: backToMainKeyboard() }
    );
    return;
  }

  // Watchlist
  if (data === "watchlist") {
    clearSession(telegramId);
    await showWatchlistScreen(ctx, telegramId);
    return;
  }

  // Auto-mint toggle
  if (data === "auto_on" || data === "auto_off") {
    const enabled = data === "auto_on";
    await setAutoMintEnabled(telegramId, enabled);
    await ctx.editMessageText(
      `${MAIN_MENU_TEXT}\n\n✅ Auto-Mint is now ${enabled ? "ON" : "OFF"}.`,
      {
        reply_markup: mainMenuKeyboard(enabled),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Manual mint
  if (data === "manual_mint") {
    setSession(telegramId, { action: "manual_mint" });
    await ctx.editMessageText(
      `🚀 **Manual Mint**\n\nPlease paste a contract address (0x...) to mint from all your active (✅) wallets.`,
      { parse_mode: "Markdown", reply_markup: backToMainKeyboard() }
    );
    return;
  }

  // Scan from watchlist
  if (data.startsWith("scan_")) {
    const addr = data.slice(5);
    clearSession(telegramId);
    await performScan(ctx, telegramId, addr);
    return;
  }

  // Mint from watchlist
  if (data.startsWith("mint_")) {
    const addr = data.slice(5);
    clearSession(telegramId);
    await performMint(ctx, telegramId, addr);
    return;
  }

  // Remove from watchlist
  if (data.startsWith("rmwatch_")) {
    const addr = data.slice(8);
    await removeFromWatchlist(telegramId, addr);
    await showWatchlistScreen(ctx, telegramId);
    return;
  }

  // Confirm mint
  if (data.startsWith("confirm_mint_")) {
    const addr = data.slice(13);
    clearSession(telegramId);
    await performMint(ctx, telegramId, addr);
    return;
  }
}

export async function handleText(ctx: Context) {
  if (!ctx.message || !ctx.message.text) return;
  if (!ctx.from) return;

  const telegramId = BigInt(ctx.from.id);
  const text = ctx.message.text.trim();
  const session = getSession(telegramId);

  // Handle custom gas funding input
  if (session.action === "fund_custom") {
    clearSession(telegramId);
    let amountEth = 0;
    const clean = text.toLowerCase().replace("$", "").replace("usd", "").replace("eth", "").trim();
    const numericVal = parseFloat(clean);

    if (isNaN(numericVal) || numericVal <= 0) {
      await ctx.reply("❌ Invalid amount entered. Please try again.", {
        reply_markup: backToWalletsKeyboard(),
      });
      return;
    }

    if (text.includes("$") || text.toLowerCase().includes("usd")) {
      amountEth = await usdToEth(numericVal);
    } else {
      amountEth = numericVal;
    }

    amountEth = Math.round(amountEth * 1e6) / 1e6;

    await ctx.reply(`🚀 *Distributing ${amountEth} ETH (~$${numericVal.toFixed(2)}) to each sub-wallet...*`, {
      parse_mode: "Markdown",
    });

    try {
      const fund = await fundSubWallets(telegramId, amountEth);
      let report = `✅ **Gas Distribution Completed!**\n\n💰 **Total Dispatched:** \`${fund.totalDistributedEth.toFixed(5)} ETH\`\n\n`;

      for (const res of fund.results) {
        if (res.txHash) {
          report += `• **${res.walletLabel}**: Funded \`${res.fundedEth} ETH\` ([Tx](https://basescan.org/tx/${res.txHash}))\n`;
        } else {
          report += `• **${res.walletLabel}**: Failed (${res.error})\n`;
        }
      }

      await ctx.reply(report, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
        reply_markup: backToWalletsKeyboard(),
      });
    } catch (err) {
      await ctx.reply(`❌ Distribution failed: ${errorMessage(err)}`, {
        reply_markup: backToWalletsKeyboard(),
      });
    }
    return;
  }

  // Contract address auto-scan
  if (isValidAddress(text)) {
    const normalizedAddr = normalizeAddressInput(text);
    if (session.action === "manual_mint") {
      clearSession(telegramId);
      await performMint(ctx, telegramId, normalizedAddr);
      return;
    }
    if (session.action === "scan") {
      clearSession(telegramId);
      await performScan(ctx, telegramId, normalizedAddr);
      return;
    }
    clearSession(telegramId);
    await performScan(ctx, telegramId, normalizedAddr);
    return;
  }

  // Private key import
  if (isValidPrivateKey(text)) {
    if (session.action === "import_key") {
      clearSession(telegramId);
      await performImport(ctx, telegramId, text);
      return;
    }
    clearSession(telegramId);
    await performImport(ctx, telegramId, text);
    return;
  }

  if (session.action === "import_key") {
    await ctx.reply(
      "❌ That doesn't look like a valid private key. Expected 64 hex characters (with or without 0x prefix).",
      { reply_markup: backToMainKeyboard() }
    );
    return;
  }

  if (session.action === "scan" || session.action === "manual_mint") {
    await ctx.reply(
      "❌ That doesn't look like a valid contract address. Expected 0x followed by 40 hex characters.",
      { reply_markup: backToMainKeyboard() }
    );
    return;
  }

  await showMainMenu(ctx);
}

async function showPortfolioScreen(ctx: Context, telegramId: bigint) {
  const wallets = await getWallets(telegramId);

  if (wallets.length === 0) {
    const text = `🖼 **My Portfolio**\n\nNo wallets found. Generate or import a wallet first.`;
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { reply_markup: backToMainKeyboard(), parse_mode: "Markdown" });
    } else {
      await ctx.reply(text, { reply_markup: backToMainKeyboard(), parse_mode: "Markdown" });
    }
    return;
  }

  let text = `📊 **Base NFT Portfolio & Valuation**\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  let combinedFloorEth = 0;
  let totalNftsHeld = 0;
  const sellButtons: Array<Array<{ text: string; callback_data: string }>> = [];

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const portfolio = await fetchWalletPortfolio(w.address);
    const shortAddr = shortenAddress(w.address);

    text += `👛 **${w.label}** (\`${shortAddr}\`):\n`;
    text += `📦 Holdings: ${portfolio.totalNfts} NFT(s)\n`;
    text += `💎 Est. Floor Value: ${portfolio.totalFloorValueEth.toFixed(4)} ETH\n`;

    if (portfolio.items.length > 0) {
      for (const item of portfolio.items.slice(0, 3)) {
        const floorDisplay = item.floorPriceEth > 0 ? `${item.floorPriceEth} ETH` : "Unlisted";
        const bidDisplay = item.topBidEth > 0 ? `${item.topBidEth} ETH` : "None";
        text += `  • **${item.collectionName}** (#${item.tokenId})\n`;
        text += `    Floor: \`${floorDisplay}\` | Bid: \`${bidDisplay}\`\n`;
        text += `    🔗 [OpenSea](${item.openseaUrl})\n`;

        sellButtons.push([
          { 
            text: `💰 Sell #${item.tokenId} (${item.topBidEth > 0 ? `${item.topBidEth} ETH` : "Dump"})`, 
            callback_data: `sell_${item.contractAddress}_${item.tokenId}_${w.id}` 
          }
        ]);
      }
    } else {
      text += `  _No NFTs found in this wallet._\n`;
    }
    text += `\n`;

    combinedFloorEth += portfolio.totalFloorValueEth;
    totalNftsHeld += portfolio.totalNfts;
  }

  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `🏷 **Total NFTs Across Wallets:** ${totalNftsHeld}\n`;
  text += `💰 **Combined Floor Value:** ${combinedFloorEth.toFixed(4)} ETH`;

  const kb = portfolioKeyboard();
  for (const btnRow of sellButtons) {
    kb.row(...btnRow.map((b) => InlineKeyboard.text(b.text, b.callback_data)));
  }

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, {
      reply_markup: kb,
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
    });
  } else {
    await ctx.reply(text, {
      reply_markup: kb,
      parse_mode: "Markdown",
      link_preview_options: { is_disabled: true },
    });
  }
}

async function showWalletsScreen(ctx: Context, telegramId: bigint) {
  const wallets = await getWallets(telegramId);

  if (wallets.length === 0) {
    await ctx.editMessageText(
      `💼 **My Wallets**\n\nNo wallets yet. Generate a new wallet or import an existing one.`,
      {
        reply_markup: new InlineKeyboard()
          .text("➕ Generate New", "new_wallet").row()
          .text("📥 Import Key", "import_key").row()
          .text("🏠 Main Menu", "main_menu"),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  let text = `💼 **My Wallets**\n\n`;
  text += `Total: ${wallets.length} | Active: ${wallets.filter((w) => w.isActive).length}\n\n`;
  text += `Click a wallet to toggle its active state:\n`;
  text += `✅ = allowed to mint | ❌ = disabled\n`;

  await ctx.editMessageText(text, {
    reply_markup: walletsKeyboard(wallets),
    parse_mode: "Markdown",
  });
}

async function showDeleteScreen(ctx: Context, telegramId: bigint) {
  const wallets = await getWallets(telegramId);

  if (wallets.length === 0) {
    await ctx.editMessageText("No wallets to delete.", {
      reply_markup: backToWalletsKeyboard(),
    });
    return;
  }

  await ctx.editMessageText(
    `🗑 **Delete Wallet**\n\nClick a wallet to permanently delete it. This cannot be undone!`,
    {
      reply_markup: deleteWalletKeyboard(wallets),
      parse_mode: "Markdown",
    }
  );
}

async function showExportScreen(ctx: Context, telegramId: bigint) {
  const wallets = await getWallets(telegramId);

  if (wallets.length === 0) {
    await ctx.editMessageText("No wallets to export.", {
      reply_markup: backToWalletsKeyboard(),
    });
    return;
  }

  await ctx.editMessageText(
    `🔑 **Export Keys**\n\n⚠️ **WARNING:** Exported keys will be shown in plain text. Save them immediately and delete the message.\n\nClick a wallet to reveal its private key:`,
    {
      reply_markup: exportWalletsKeyboard(wallets),
      parse_mode: "Markdown",
    }
  );
}

async function showWatchlistScreen(ctx: Context, telegramId: bigint) {
  const items = await getWatchlist(telegramId);
  const contracts = items.map((w) => w.contractAddress);

  let text = `👁 **Watchlist**\n\n`;

  if (contracts.length === 0) {
    text += `Your watchlist is empty.\n\n`;
    text += `Paste a contract address in chat to scan it, then add it to your watchlist.`;
  } else {
    text += `Tracking ${contracts.length} contract(s):\n\n`;
    for (const c of contracts) {
      text += `• \`${c}\`\n`;
    }
    text += `\nUse the buttons below to scan, mint, or remove contracts.`;
  }

  await ctx.editMessageText(text, {
    reply_markup: watchlistKeyboard(contracts),
    parse_mode: "Markdown",
  });
}

async function performScan(ctx: Context, telegramId: bigint, address: string) {
  await ctx.reply(`🔍 Scanning contract \`${shortenAddress(address)}\`...`, {
    parse_mode: "Markdown",
  });

  try {
    const result = await scanContract(address);

    if (!result.isContract) {
      await ctx.reply(
        `❌ No contract found at \`${shortenAddress(address)}\``,
        {
          reply_markup: backToMainKeyboard(),
          parse_mode: "Markdown",
        }
      );
      return;
    }

    let text = `🔍 **Scan Results**\n\n`;
    text += `Contract: \`${result.contractAddress}\`\n`;
    text += `Verified: ${result.isVerified ? "✅ Yes" : "❌ No"}\n\n`;

    if (result.mintFunctions.length > 0) {
      text += `**Free Mint Functions Found:**\n`;
      for (const fn of result.mintFunctions) {
        text += `• ${fn.name}(${fn.args.join(", ")}) — ✅ Free\n`;
      }
      text += `\n🚀 This contract has free mint functions!`;

      await addToWatchlist(telegramId, address);

      await ctx.reply(text, {
        reply_markup: confirmMintKeyboard(address),
        parse_mode: "Markdown",
      });
    } else {
      text += result.warning || "No free mint functions detected.";
      await ctx.reply(text, {
        reply_markup: backToMainKeyboard(),
        parse_mode: "Markdown",
      });
    }
  } catch (error) {
    await ctx.reply(`❌ Scan failed: ${errorMessage(error)}`, {
      reply_markup: backToMainKeyboard(),
    });
  }
}

async function performMint(ctx: Context, telegramId: bigint, address: string) {
  const gasCheck = await checkGasSafety(telegramId);
  if (!gasCheck.safe) {
    await ctx.reply(
      `⚠️ **MINT ABORTED (HIGH GAS)**\n\n` +
      `Current Network Gas: \`${gasCheck.currentGwei.toFixed(4)} Gwei\`\n` +
      `Your Configured Max: \`${gasCheck.maxGwei} Gwei\`\n\n` +
      `The bot paused this mint to prevent burning high gas fees. You can adjust your limit in **🛡 Settings / Gas**.`,
      {
        reply_markup: backToMainKeyboard(),
        parse_mode: "Markdown",
      }
    );
    return;
  }

  const wallets = await getWallets(telegramId);
  const activeCount = wallets.filter((w) => w.isActive).length;

  if (activeCount === 0) {
    await ctx.reply(
      "❌ No active wallets. Toggle at least one wallet to ✅ before minting.",
      { reply_markup: backToWalletsKeyboard() }
    );
    return;
  }

  const multiplier = getUserMintQuantity(telegramId);

  await ctx.reply(
    `🚀 **Starting Mint**\n\n` +
    `Contract: \`${shortenAddress(address)}\`\n` +
    `Active Wallets: ${activeCount} (x${multiplier} each)\n` +
    `Gas Price: \`${gasCheck.currentGwei.toFixed(4)} Gwei\` (Safe ✅)\n\n` +
    `Minting in progress...`,
    { parse_mode: "Markdown" }
  );

  try {
    const result = await batchMint(telegramId, address);

    if (result.results.length === 0) {
      await ctx.reply(
        `❌ No free mint functions detected on this contract. Aborting.`,
        { reply_markup: backToMainKeyboard() }
      );
      return;
    }

    for (const r of result.results) {
      const statusIcon = r.success ? "✅" : "❌";
      let card = `${statusIcon} **${r.label}** — ${r.success ? "Minted!" : "Failed"}\n`;
      card += `Wallet: \`${shortenAddress(r.walletAddress)}\`\n`;

      if (r.txHash && r.basescanUrl) {
        card += `TX: [${shortenAddress(r.txHash, 8, 8)}](${r.basescanUrl})\n`;
      }
      if (r.error) {
        card += `Error: ${r.error}\n`;
      }

      await ctx.reply(card, {
        parse_mode: "Markdown",
        link_preview_options: { is_disabled: true },
      });
    }

    await ctx.reply(
      `📊 **Mint Summary**\n\nContract: \`${shortenAddress(address)}\`\n✅ Success: ${result.totalSuccess}\n❌ Failed: ${result.totalFailed}\nTotal Attempts: ${result.results.length}`,
      {
        reply_markup: backToMainKeyboard(),
        parse_mode: "Markdown",
      }
    );
  } catch (error) {
    await ctx.reply(`❌ Mint failed: ${errorMessage(error)}`, {
      reply_markup: backToMainKeyboard(),
    });
  }
}

async function performImport(ctx: Context, telegramId: bigint, privateKey: string) {
  try {
    const wallet = await importWallet(telegramId, privateKey);
    await ctx.reply(
      `✅ Wallet imported successfully!\n\n📋 Label: ${wallet.label}\n📍 Address: \`${wallet.address}\`\n\nThis wallet is now active (✅) and ready to mint.`,
      {
        parse_mode: "Markdown",
        reply_markup: backToWalletsKeyboard(),
      }
    );
  } catch (error) {
    await ctx.reply(`❌ Import failed: ${errorMessage(error)}`, {
      reply_markup: backToWalletsKeyboard(),
    });
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
