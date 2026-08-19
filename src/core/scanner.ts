import { 
  type Address, 
  type Hex, 
  type Abi, 
  parseAbi, 
  encodeFunctionData, 
  getFunctionSelector,
  getAddress,
  isAddress 
} from "viem";
import { getPublicClient } from "./chain.js";
import { auditContractSecurity, type SecurityReport } from "./security.js";

export interface MintFunctionInfo {
  name: string;
  selector: string;
  args: string[];
  isFreeMint: boolean;
  requiresPayment: boolean;
}

export interface ScanResult {
  contractAddress: string;
  mintFunctions: MintFunctionInfo[];
  isVerified: boolean;
  abi: Abi | null;
  bytecode: Hex | null;
  isContract: boolean;
  security: SecurityReport;
  warning?: string;
}

// Known legitimate NFT Creator Factory and Protocol Addresses on Base (e.g. Zora Creator / Factory)
const VERIFIED_FACTORIES = new Set([
  "0x777777751622c0d3258f214f9df38e35bf45baf3", // Zora Factory on Base
  // Add other trusted factory contracts or creator registries here as needed
]);

// Comprehensive free-mint signatures (Standard ERC-721/1155/Zora)
const FREE_MINT_PATTERNS: Array<{ name: string; args: string[] }> = [
  { name: "mint", args: [] },
  { name: "mint", args: ["uint256"] },
  { name: "mint", args: ["address", "uint256"] },
  { name: "mintFree", args: [] },
  { name: "mintFree", args: ["uint256"] },
  { name: "publicMint", args: [] },
  { name: "publicMint", args: ["uint256"] },
  { name: "freeMint", args: [] },
  { name: "freeMint", args: ["uint256"] },
  { name: "claim", args: [] },
  { name: "claim", args: ["uint256"] },
  { name: "claim", args: ["address", "uint256"] },
];

const PAID_MINT_PATTERNS = [
  "mintWithETH", 
  "paidMint", 
  "mintWithPayment", 
  "mintWithPrice", 
  "purchase"
];

export async function fetchContractAbi(address: string): Promise<{ abi: Abi | null; isVerified: boolean }> {
  const apiKey = process.env.BASESCAN_API_KEY || "";
  const baseUrl = process.env.BASESCAN_API_URL || "https://api.etherscan.io/v2/api";

  const isV2 = baseUrl.includes("etherscan.io/v2");
  const chainParam = isV2 ? "chainid=8453&" : "";
  const keyParam = apiKey ? `&apikey=${apiKey}` : "";

  const url = `${baseUrl}?${chainParam}module=contract&action=getabi&address=${address}${keyParam}`;

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" }
    });
    const data = (await response.json()) as { status?: string; result?: string; message?: string };

    if (data.status === "1" && data.result && data.result.startsWith("[")) {
      const abi = JSON.parse(data.result) as Abi;
      return { abi, isVerified: true };
    }

    return { abi: null, isVerified: false };
  } catch (error) {
    console.error("ABI fetch error:", error);
    return { abi: null, isVerified: false };
  }
}

export async function getBytecode(address: Address): Promise<Hex | null> {
  const client = getPublicClient();
  try {
    const code = await client.getCode({ address });
    if (!code || code === "0x") return null;
    return code;
  } catch (err) {
    console.error("Error fetching bytecode from RPC:", err);
    return null;
  }
}

export function analyzeAbiForMintFunctions(abi: Abi): MintFunctionInfo[] {
  const functions: MintFunctionInfo[] = [];

  for (const item of abi) {
    if (item.type !== "function") continue;

    const fn = item as unknown as {
      name: string;
      inputs: Array<{ type: string; name: string }>;
      stateMutability?: string;
      payable?: boolean;
    };

    const isPaid = PAID_MINT_PATTERNS.some((p) => fn.name.toLowerCase().includes(p.toLowerCase()));
    const isPayable = fn.stateMutability === "payable" || fn.payable === true;
    const isMintName = /mint|claim|collect/i.test(fn.name);

    if (isMintName) {
      try {
        const selector = getFunctionSelector({
          name: fn.name,
          type: "function",
          inputs: fn.inputs.map((i) => ({ type: i.type, name: i.name || "" })),
          outputs: [],
          stateMutability: fn.stateMutability || "nonpayable",
        } as any);

        functions.push({
          name: fn.name,
          selector,
          args: fn.inputs.map((i) => i.type),
          isFreeMint: !isPayable && !isPaid,
          requiresPayment: isPayable || isPaid,
        });
      } catch {
        // Skip non-standard ABI entries
      }
    }
  }

  return functions;
}

export async function scanContract(rawAddress: string): Promise<ScanResult> {
  const cleanInput = rawAddress.trim();
  const hexAddress = cleanInput.startsWith("0x") ? cleanInput : `0x${cleanInput}`;

  if (!isAddress(hexAddress)) {
    return {
      contractAddress: hexAddress,
      mintFunctions: [],
      isVerified: false,
      abi: null,
      bytecode: null,
      isContract: false,
      security: { isSafe: false, isHoneypot: false, isDrainer: false, riskScore: 100, warnings: ["Invalid address format"] },
      warning: "Invalid Ethereum contract address format.",
    };
  }

  const checksumAddress = getAddress(hexAddress);

  // 1. Fetch bytecode from RPC
  const bytecode = await getBytecode(checksumAddress);
  
  // 2. Fetch ABI from explorer
  const { abi, isVerified } = await fetchContractAbi(checksumAddress);

  if (!bytecode && !abi) {
    return {
      contractAddress: checksumAddress,
      mintFunctions: [],
      isVerified: false,
      abi: null,
      bytecode: null,
      isContract: false,
      security: { isSafe: false, isHoneypot: false, isDrainer: false, riskScore: 100, warnings: ["No contract deployed"] },
      warning: "No contract found at this address on Base.",
    };
  }

  // === QUALITY FILTER 1: Skip Unverified Random Junk ===
  // Professional drops almost always have verified source code on BaseScan.
  if (!isVerified) {
    return {
      contractAddress: checksumAddress,
      mintFunctions: [],
      isVerified: false,
      abi,
      bytecode,
      isContract: true,
      security: { isSafe: false, isHoneypot: false, isDrainer: false, riskScore: 50, warnings: ["Unverified contract source"] },
      warning: "Skipped: Contract source code is unverified (Potential low-quality / junk drop).",
    };
  }

  // 3. Security & Honeypot Audit
  const security = await auditContractSecurity(checksumAddress);

  if (!security.isSafe) {
    return {
      contractAddress: checksumAddress,
      mintFunctions: [],
      isVerified,
      abi,
      bytecode,
      isContract: true,
      security,
      warning: `🚨 UNSAFE CONTRACT: ${security.warnings.join(", ")}`,
    };
  }

  let mintFunctions: MintFunctionInfo[] = [];
  if (abi) {
    mintFunctions = analyzeAbiForMintFunctions(abi);
  }

  const freeMintFunctions = mintFunctions.filter((f) => f.isFreeMint && !f.requiresPayment);

  // === QUALITY FILTER 2: Require Valid Free Mint Functions ===
  if (freeMintFunctions.length === 0) {
    return {
      contractAddress: checksumAddress,
      mintFunctions: [],
      isVerified,
      abi,
      bytecode,
      isContract: true,
      security,
      warning: "Skipped: No valid verified free-mint function detected.",
    };
  }

  return {
    contractAddress: checksumAddress,
    mintFunctions: freeMintFunctions,
    isVerified,
    abi,
    bytecode,
    isContract: true,
    security,
    warning: undefined,
  };
}

export async function simulateMint(
  contractAddress: string,
  fromAddress: string,
  mintFunction: MintFunctionInfo
): Promise<{ success: boolean; error?: string }> {
  const client = getPublicClient();

  try {
    const abiItem = parseAbi([`function ${mintFunction.name}(${mintFunction.args.join(",")})`] as const);

    const args = mintFunction.args.map((type) => {
      if (type === "uint256") return 1n;
      if (type === "address") return getAddress(fromAddress);
      if (type === "bytes32[]") return [];
      return "0x";
    });

    const data = encodeFunctionData({
      abi: abiItem,
      functionName: mintFunction.name,
      args: args as any,
    });

    await client.call({
      data,
      to: getAddress(contractAddress),
      account: getAddress(fromAddress),
      value: 0n,
    });

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export function getBestMintFunction(functions: MintFunctionInfo[]): MintFunctionInfo | null {
  const noArg = functions.find((f) => f.args.length === 0);
  if (noArg) return noArg;
  const withArg = functions.find((f) => f.args.length === 1 && f.args[0] === "uint256");
  if (withArg) return withArg;
  return functions[0] || null;
}
