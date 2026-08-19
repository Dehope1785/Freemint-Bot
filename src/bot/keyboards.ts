import { InlineKeyboard } from "grammy";
import { shortenAddress } from "../core/chain.js";
import type { WalletInfo } from "../core/wallet.js";

export function mainMenuKeyboard(autoMintEnabled: boolean): InlineKeyboard {
  const toggleText = autoMintEnabled ? "⚡ Auto-Mint: ON" : "⚡ Auto-Mint: OFF";
  const toggleData = autoMintEnabled ? "auto_off" : "auto_on";

  return new InlineKeyboard()
    .text("💼 My Wallets", "wallets").text("➕ New Wallet", "new_wallet").row()
    .text("🖼 My Portfolio", "portfolio").text("🔍 Scan Contract", "scan_contract").row()
    .text("👁 Watchlist", "watchlist").text("🚀 Manual Mint", "manual_mint").row()
    .text(toggleText, toggleData).text("🛡 Settings / Gas", "settings");
}

export function settingsMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔢 Mint Multiplier (Quantity / Wallet)", "menu_mint_qty").row()
    .text("⛽ Gas Price Ceiling Guard", "menu_gas_guard").row()
    .text("📖 Full Help & Guide", "menu_help_text").row()
    .text("🏠 Main Menu", "main_menu");
}

export function quantitySettingsKeyboard(currentQty: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(`${currentQty === 1 ? "✅ " : ""}1x Per Wallet`, "setqty_1")
    .text(`${currentQty === 2 ? "✅ " : ""}2x Per Wallet`, "setqty_2").row()
    .text(`${currentQty === 3 ? "✅ " : ""}3x Per Wallet`, "setqty_3")
    .text(`${currentQty === 5 ? "✅ " : ""}5x Per Wallet`, "setqty_5").row()
    .text(`${currentQty === 10 ? "✅ " : ""}10x Max Turbo`, "setqty_10").row()
    .text("🔙 Settings", "settings").text("🏠 Main Menu", "main_menu");
}

export function gasSettingsKeyboard(currentMax: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(`${currentMax === 0.02 ? "✅ " : ""}0.02 Gwei (Ultra Cheap)`, "setgas_0.02").row()
    .text(`${currentMax === 0.05 ? "✅ " : ""}0.05 Gwei (Recommended)`, "setgas_0.05").row()
    .text(`${currentMax === 0.10 ? "✅ " : ""}0.10 Gwei (Fast)`, "setgas_0.10").row()
    .text(`${currentMax === 0.25 ? "✅ " : ""}0.25 Gwei (Aggressive)`, "setgas_0.25").row()
    .text("🔙 Settings", "settings").text("🏠 Main Menu", "main_menu");
}

export function portfolioKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📦 Sweep All NFTs to Wallet 1", "sweep_nfts").row()
    .text("🔄 Refresh Portfolio", "portfolio").row()
    .text("🏠 Main Menu", "main_menu");
}

export function fundAmountKeyboard(ethPrice: number): InlineKeyboard {
  const calcUsd = (eth: number) => (eth * ethPrice).toFixed(2);

  return new InlineKeyboard()
    .text(`⚡ 0.0003 ETH (~$${calcUsd(0.0003)})`, "fund_0.0003")
    .text(`⚡ 0.0005 ETH (~$${calcUsd(0.0005)})`, "fund_0.0005").row()
    .text(`⚡ 0.0010 ETH (~$${calcUsd(0.0010)})`, "fund_0.001")
    .text(`⚡ 0.0020 ETH (~$${calcUsd(0.0020)})`, "fund_0.002").row()
    .text("✍️ Custom Amount ($ / ETH)", "fund_custom").row()
    .text("🔙 Wallets", "wallets").text("🏠 Main Menu", "main_menu");
}

export function walletsKeyboard(wallets: WalletInfo[]): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (let i = 0; i < wallets.length; i += 2) {
    const w1 = wallets[i];
    const w2 = wallets[i + 1];

    const w1Text = `${w1.isActive ? "✅" : "❌"} ${w1.label}: ${shortenAddress(w1.address)}`;
    kb.text(w1Text, `toggle_${w1.id}`);

    if (w2) {
      const w2Text = `${w2.isActive ? "✅" : "❌"} ${w2.label}: ${shortenAddress(w2.address)}`;
      kb.text(w2Text, `toggle_${w2.id}`);
    }
    kb.row();
  }

  kb.text("➕ Generate New", "new_wallet").row()
    .text("⛽ Refuel / Distribute Gas", "fund_menu").row()
    .text("🧹 Sweep All ETH Dust", "sweep_dust").row()
    .text("📥 Import Key", "import_key").row()
    .text("🔑 Export Keys", "export_keys").row()
    .text("🗑 Delete Wallet", "delete_wallet").row()
    .text("🏠 Main Menu", "main_menu");

  return kb;
}

export function deleteWalletKeyboard(wallets: WalletInfo[]): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (let i = 0; i < wallets.length; i += 2) {
    const w1 = wallets[i];
    const w2 = wallets[i + 1];

    kb.text(`🗑 ${w1.label}: ${shortenAddress(w1.address)}`, `del_${w1.id}`);

    if (w2) {
      kb.text(`🗑 ${w2.label}: ${shortenAddress(w2.address)}`, `del_${w2.id}`);
    }
    kb.row();
  }

  kb.text("🔙 Back to Wallets", "wallets").row()
    .text("🏠 Main Menu", "main_menu");

  return kb;
}

export function exportWalletsKeyboard(wallets: WalletInfo[]): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (const w of wallets) {
    kb.text(`🔑 ${w.label}: ${shortenAddress(w.address)}`, `export_${w.id}`).row();
  }

  kb.text("🔙 Back to Wallets", "wallets").row()
    .text("🏠 Main Menu", "main_menu");

  return kb;
}

export function watchlistKeyboard(contracts: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (let i = 0; i < contracts.length; i += 2) {
    const c1 = contracts[i];
    const c2 = contracts[i + 1];

    kb.text(`🔍 ${shortenAddress(c1, 4, 4)}`, `scan_${c1}`);

    if (c2) {
      kb.text(`🔍 ${shortenAddress(c2, 4, 4)}`, `scan_${c2}`);
    }
    kb.row();
  }

  for (let i = 0; i < contracts.length; i += 2) {
    const c1 = contracts[i];
    const c2 = contracts[i + 1];

    kb.text(`🚀 Mint ${shortenAddress(c1, 4, 4)}`, `mint_${c1}`);

    if (c2) {
      kb.text(`🚀 Mint ${shortenAddress(c2, 4, 4)}`, `mint_${c2}`);
    }
    kb.row();
  }

  for (let i = 0; i < contracts.length; i += 2) {
    const c1 = contracts[i];
    const c2 = contracts[i + 1];

    kb.text(`❌ Remove ${shortenAddress(c1, 4, 4)}`, `rmwatch_${c1}`);

    if (c2) {
      kb.text(`❌ Remove ${shortenAddress(c2, 4, 4)}`, `rmwatch_${c2}`);
    }
    kb.row();
  }

  kb.text("🏠 Main Menu", "main_menu");

  return kb;
}

export function confirmMintKeyboard(contractAddress: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Confirm Mint", `confirm_mint_${contractAddress}`).row()
    .text("❌ Cancel", "main_menu");
}

export function backToMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🏠 Main Menu", "main_menu");
}

export function backToWalletsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔙 Wallets", "wallets").row()
    .text("🏠 Main Menu", "main_menu");
}
