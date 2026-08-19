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

// Comprehensive free-mint signatures (covering 721, 1155, Zora, and Manifold)
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
  { name: "claim", args: ["address", "uint256", "bytes32[]"] },
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

    if (isV2 && (!data.result || data.status !== "1")) {
      const fallbackUrl = `https://api.basescan.org/api?module=contract&action=getabi&address=${address}${keyParam}`;
      const fallbackRes = await fetch(fallbackUrl);
      const fallbackData = (await fallbackRes.json()) as { status?: string; result?: string };
      if (fallbackData.status === "1" && fallbackData.result && fallbackData.result.startsWith("[")) {
        return { abi: JSON.parse(fallbackData.result) as Abi, isVerified: true };
      }
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

export function analyzeBytecodeForMintSelectors(bytecode: Hex): MintFunctionInfo[] {
  const found: MintFunctionInfo[] = [];

  for (const pattern of FREE_MINT_PATTERNS) {
    try {
      const abiItem = parseAbi([`function ${pattern.name}(${pattern.args.join(",")})`] as const);
      const selector = getFunctionSelector(abiItem[0] as any);

      if (bytecode.includes(selector.slice(2))) {
        found.push({
          name: pattern.name,
          selector,
          args: pattern.args,
          isFreeMint: true,
          requiresPayment: false,
        });
      }
    } catch {
      // Continue search
    }
  }

  return found;
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

  // 3. Security & Honeypot Audit
  const security = await auditContractSecurity(checksumAddress);

  // If flagged as unsafe/honeypot, abort
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

  // Fallback: Check bytecode for known function selectors if unverified
  if (mintFunctions.length === 0 && bytecode) {
    mintFunctions = analyzeBytecodeForMintSelectors(bytecode);
  }

  const freeMintFunctions = mintFunctions.filter((f) => f.isFreeMint && !f.requiresPayment);
  const paidFunctions = mintFunctions.filter((f) => f.requiresPayment);

  let warning: string | undefined;
  if (paidFunctions.length > 0 && freeMintFunctions.length === 0) {
    warning = "All detected mint functions require payment (Not a Free Mint).";
  } else if (mintFunctions.length === 0) {
    warning = "No standard mint functions detected on this contract.";
  }

  return {
    contractAddress: checksumAddress,
    mintFunctions: freeMintFunctions,
    isVerified,
    abi,
    bytecode,
    isContract: true,
    security,
    warning,
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
  const withRecipient = functions.find((f) => f.args.includes("address"));
  if (withRecipient) return withRecipient;
  return functions[0] || null;
}
