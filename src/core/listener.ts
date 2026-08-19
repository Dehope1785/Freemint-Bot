import { type Hex, getAddress } from "viem";
import { getPublicClient } from "./chain.js";
import { scanContract, simulateMint, type MintFunctionInfo } from "./scanner.js";

// Common 4-byte free-mint selectors
const MINT_SELECTORS = new Set([
  "0x1249c58b", // mint()
  "0xa0712d68", // mint(uint256)
  "0x6a627842", // mint(address)
  "0x4e6ec247", // claim()
  "0xefef39a1", // publicMint()
  "0x84bb1e42", // mintFree()
  "0xa6f2ae3a", // claim(address,uint256)
]);

export interface DropEvent {
  contractAddress: string;
  selector: string;
  txHash: string;
  timestamp: number;
}

export type DropCallback = (drop: DropEvent) => Promise<void>;

export class BaseDropListener {
  private isRunning = false;
  private unwatch: (() => void) | null = null;
  private seenContracts = new Set<string>();
  private onDropDetected: DropCallback;

  constructor(onDropDetected: DropCallback) {
    this.onDropDetected = onDropDetected;
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log("📡 Free-Mint Auto-Discovery Listener active on Base...");

    const client = getPublicClient();

    // Stream blocks and examine transaction calldata
    this.unwatch = client.watchBlocks({
      includeTransactions: true,
      emitMissed: false,
      onBlock: async (block) => {
        for (const tx of block.transactions) {
          if (!tx.to || !tx.input || tx.input === "0x") continue;

          // Only evaluate zero-value transactions (free mints)
          if (tx.value !== 0n) continue;

          const selector = tx.input.slice(0, 10).toLowerCase();

          if (MINT_SELECTORS.has(selector)) {
            const contractAddr = getAddress(tx.to);

            // Avoid duplicate processing within the same session
            if (this.seenContracts.has(contractAddr)) continue;
            this.seenContracts.add(contractAddr);

            // Keep cache bounded
            if (this.seenContracts.size > 2000) {
              this.seenContracts.clear();
            }

            console.log(`🎯 Free-mint candidate detected: ${contractAddr} (sig: ${selector})`);

            this.onDropDetected({
              contractAddress: contractAddr,
              selector,
              txHash: tx.hash,
              timestamp: Date.now(),
            }).catch((err) => console.error("Drop handler error:", err));
          }
        }
      },
      onError: (error) => {
        console.error("Block watcher error, retrying...", error);
      },
    });
  }

  public stop() {
    if (this.unwatch) {
      this.unwatch();
      this.unwatch = null;
    }
    this.isRunning = false;
    console.log("🛑 Auto-Discovery Listener stopped.");
  }
}
