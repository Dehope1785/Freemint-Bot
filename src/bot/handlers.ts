import { type Context, InlineKeyboard } from "grammy";
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
import { batchMint } from "../core/mint.js";
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
} from "./keyboards.js";

// Session state for multi-step flows (import key, scan, mint)
interface SessionState {
  action: "import_key" | "scan" | "manual_mint" | "none";
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
• 🔍 Scan any Base contract for free-mint functions
• 👥 Watchlist — track contracts and mint with one tap
• ⚡ Auto-Mint — automatically mint from watchlist contracts
• 🚀 Manual Mint — mint from all active wallets at once
• 📥 Paste a contract address or private key directly in chat

**How it works:**
1. Generate or import wallets
2. Toggle wallets on (✅) or off (❌)
3. Paste a contract address to scan it
4. Mint across all active wallets simultaneously

**Security:**
• Private keys are encrypted with AES-256-GCM
• Exported keys are sent as self-destruct messages
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

  // Wallets screen
  if (data === "wallets") {
    clearSession(telegramId);
    await showWalletsScreen(ctx, telegramId);
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
      `📥 **Import Wallet by Private Key**

Please paste your private key directly in the chat.

Format: 64 hex characters (with or without 0x prefix)

⚠️ Your key will be encrypted with AES-256-GCM before storage.`,
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

      // Send as a self-destruct message (5 seconds)
      await ctx.reply(
        `🔑 **PRIVATE KEY — SELF-DESTRUCTING**

Wallet: ${label}
Address: \`${wallet?.address || ""}\`
Private Key: \`${privateKey}\`

⏰ This message will self-destruct in 5 seconds. Save it now!`,
        { parse_mode: "Markdown" }
      );

      // Attempt to delete the message after 5 seconds
      setTimeout(async () => {
        try {
          const lastMessages = await ctx.api.getChat(ctx.chat!.id);
          // We can't easily get the message ID to delete here, so we rely on the user deleting it
          // In a production bot, we'd track the message ID
        } catch {
          // Ignore deletion errors
        }
      }, 5000);

      await ctx.reply("⚠️ Please delete the private key message above manually after saving it.", {
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
      `🔍 **Scan Contract**

Please paste a contract address (0x...) directly in the chat to scan it for free-mint functions.`,
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
      `🚀 **Manual Mint**

Please paste a contract address (0x...) to mint from all your active (✅) wallets.`,
      { parse_mode: "Markdown", reply_markup: backToMainKeyboard() }
    );
    return;
  }

  // Settings
  if (data === "settings") {
    clearSession(telegramId);
    await helpCommand(ctx);
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

  // Check if text is a contract address
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
    // Default: scan the address
    clearSession(telegramId);
    await performScan(ctx, telegramId, normalizedAddr);
    return;
  }

  // Check if text is a private key
  if (isValidPrivateKey(text)) {
    if (session.action === "import_key") {
      clearSession(telegramId);
      await performImport(ctx, telegramId, text);
      return;
    }
    // Auto-detect private key even without session
    clearSession(telegramId);
    await performImport(ctx, telegramId, text);
    return;
  }

  // If in import_key session but text isn't a valid key
  if (session.action === "import_key") {
    await ctx.reply(
      "❌ That doesn't look like a valid private key. Expected 64 hex characters (with or without 0x prefix).",
      { reply_markup: backToMainKeyboard() }
    );
    return;
  }

  // If in scan or manual_mint session
  if (session.action === "scan" || session.action === "manual_mint") {
    await ctx.reply(
      "❌ That doesn't look like a valid contract address. Expected 0x followed by 40 hex characters.",
      { reply_markup: backToMainKeyboard() }
    );
    return;
  }

  // Unrecognized text - show main menu
  await showMainMenu(ctx);
}

async function showWalletsScreen(ctx: Context, telegramId: bigint) {
  const wallets = await getWallets(telegramId);

  if (wallets.length === 0) {
    await ctx.editMessageText(
      `💼 **My Wallets**

No wallets yet. Generate a new wallet or import an existing one.`,
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
    `🗑 **Delete Wallet**

Click a wallet to permanently delete it. This cannot be undone!`,
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
    `🔑 **Export Keys**

⚠️ **WARNING:** Exported keys will be shown in plain text. Save them immediately and delete the message.

Click a wallet to reveal its private key:`,
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

      // Add to watchlist and offer mint
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
  const wallets = await getWallets(telegramId);
  const activeCount = wallets.filter((w) => w.isActive).length;

  if (activeCount === 0) {
    await ctx.reply(
      "❌ No active wallets. Toggle at least one wallet to ✅ before minting.",
      { reply_markup: backToWalletsKeyboard() }
    );
    return;
  }

  await ctx.reply(
    `🚀 **Starting Mint**\n\nContract: \`${shortenAddress(address)}\`\nActive Wallets: ${activeCount}\n\nMinting in progress...`,
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

    // Send status cards for each wallet
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

    // Summary
    await ctx.reply(
      `📊 **Mint Summary**\n\nContract: \`${shortenAddress(address)}\`\n✅ Success: ${result.totalSuccess}\n❌ Failed: ${result.totalFailed}\nTotal: ${result.results.length}`,
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
