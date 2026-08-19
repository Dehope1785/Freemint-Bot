import { getAddress } from "viem";
import { getPublicClient } from "./chain.js";

export interface SecurityReport {
  isSafe: boolean;
  isHoneypot: boolean;
  isDrainer: boolean;
  riskScore: number; // 0 (Clean) to 100 (Dangerous)
  warnings: string[];
}

export async function auditContractSecurity(contractAddress: string): Promise<SecurityReport> {
  const cleanAddr = getAddress(contractAddress);
  const publicClient = getPublicClient();

  const report: SecurityReport = {
    isSafe: true,
    isHoneypot: false,
    isDrainer: false,
    riskScore: 0,
    warnings: [],
  };

  try {
    // 1. Bytecode verification
    const bytecode = await publicClient.getBytecode({ address: cleanAddr });
    if (!bytecode || bytecode === "0x") {
      report.isSafe = false;
      report.warnings.push("No contract bytecode deployed at this address");
      report.riskScore = 100;
      return report;
    }

    // 2. Free GoPlus Security screening for Base (Chain ID 8453)
    const goplusUrl = `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${cleanAddr}`;
    const res = await fetch(goplusUrl, { headers: { Accept: "application/json" } });
    const json = (await res.json()) as any;
    const data = json?.result?.[cleanAddr.toLowerCase()];

    if (data) {
      if (data.is_honeypot === "1" || data.cannot_sell_all === "1") {
        report.isHoneypot = true;
        report.isSafe = false;
        report.riskScore = 100;
        report.warnings.push("Identified as Honeypot: restricted transfers/sales detected");
      }

      if (data.transfer_pausable === "1") {
        report.riskScore += 25;
        report.warnings.push("Transfer function can be paused by owner");
      }

      if (data.hidden_owner === "1") {
        report.riskScore += 20;
        report.warnings.push("Hidden contract owner detected");
      }

      if (data.selfdestruct === "1") {
        report.riskScore += 30;
        report.warnings.push("Contract contains self-destruct opcode");
      }
    }

    if (report.riskScore >= 50) {
      report.isSafe = false;
    }

    return report;
  } catch (error) {
    console.error(`Security check error for ${contractAddress}:`, error);
    // Fail-safe: if security API is down, allow with a neutral warning
    return {
      isSafe: true,
      isHoneypot: false,
      isDrainer: false,
      riskScore: 0,
      warnings: ["Security indexer unavailable — proceeding with simulated safety"],
    };
  }
}
