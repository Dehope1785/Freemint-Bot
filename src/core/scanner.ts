import { type Address, type Hex, type Abi, parseAbi, encodeFunctionData, getFunctionSelector } from "viem";
import { getPublicClient } from "./chain.js";

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
  warning?: string;
}

// Known free-mint function signatures (name + arg types)
const FREE_MINT_PATTERNS: Array<{ name: string; args: string[] }> = [
  { name: "mintFree", args: [] },
  { name: "mintFree", args: ["uint256"] },
  { name: "publicMint", args: [] },
  { name: "publicMint", args: ["uint256"] },
  { name: "claim", args: [] },
  { name: "claim", args: ["uint256"] },
  { name: "freeMint", args: [] },
  { name: "freeMint", args: ["uint256"] },
  { name: "mint", args: [] },
  { name: "mint", args: ["uint256"] },
];

// Function names that typically require payment
const PAID_MINT_PATTERNS = ["mintWithETH", "paidMint", "mintWithPayment", "mintWithPrice"];

export async function fetchContractAbi(address: string): Promise<{ abi: Abi | null; isVerified: boolean }> {
  const apiKey = process.env.BASESCAN_API_KEY || "YourApiKeyToken";
  const baseUrl = process.env.BASESCAN_API_URL || "https://api.basescan.org/api";

  const url = `${baseUrl}?module=contract&action=getabi&address=${address}&apikey=${apiKey}`;

  try {
    const response = await fetch(url);
    const data = (await response.json()) as { status?: string; result?: string };

    if (data.status === "1" && data.result) {
      const abi = JSON.parse(data.result) as Abi;
      return { abi, isVerified: true };
    }
    return { abi: null, isVerified: false };
  } catch (error) {
    console.error("Basescan ABI fetch error:", error);
    return { abi: null, isVerified: false };
  }
}

export async function getBytecode(address: string): Promise<Hex | null> {
  const client = getPublicClient();
  const code = await client.getCode({ address: address as Address });
  if (!code || code === "0x") return null;
  return code;
}

export function analyzeAbiForMintFunctions(abi: Abi): MintFunctionInfo[] {
  const functions: MintFunctionInfo[] = [];

  for (const item of abi) {
    if (item.type !== "function") continue;

    const fn = item as unknown as {
      name: string;
      type: string;
      inputs: Array<{ type: string; name: string }>;
      stateMutability?: string;
      payable?: boolean;
    };

    // Check if this is a paid mint function
    const isPaid = PAID_MINT_PATTERNS.some((p) => fn.name.toLowerCase().includes(p.toLowerCase()));

    // Check if this matches a free mint pattern
    const matchingPattern = FREE_MINT_PATTERNS.find(
      (p) => p.name === fn.name && p.args.length === (fn.inputs?.length || 0)
    );

    if (matchingPattern) {
      const isPayable = fn.stateMutability === "payable" || fn.payable === true;
      const requiresPayment = isPaid || isPayable;

      functions.push({
        name: fn.name,
        selector: getFunctionSelector({
          name: fn.name,
          type: "function",
          inputs: fn.inputs.map((i) => ({ type: i.type, name: i.name || "" })),
          outputs: [],
          stateMutability: fn.stateMutability || "nonpayable",
        } as any),
        args: matchingPattern.args,
        isFreeMint: !requiresPayment,
        requiresPayment,
      });
    }
  }

  return functions;
}

export function analyzeBytecodeForMintSelectors(bytecode: Hex): MintFunctionInfo[] {
  const found: MintFunctionInfo[] = [];

  for (const pattern of FREE_MINT_PATTERNS) {
    try {
      const abiItem = parseAbi([
        `function ${pattern.name}(${pattern.args.join(",")})`,
      ] as const);
      const selector = getFunctionSelector(abiItem[0] as any);

      if (bytecode.includes(selector.slice(2))) {
        const isPaid = PAID_MINT_PATTERNS.some((p) => pattern.name.toLowerCase().includes(p.toLowerCase()));
        found.push({
          name: pattern.name,
          selector,
          args: pattern.args,
          isFreeMint: !isPaid,
          requiresPayment: isPaid,
        });
      }
    } catch {
      // Skip patterns that fail to parse
    }
  }

  return found;
}

export async function scanContract(address: string): Promise<ScanResult> {
  const normalizedAddr = address.toLowerCase();

  // Check if contract exists
  const bytecode = await getBytecode(normalizedAddr);
  if (!bytecode) {
    return {
      contractAddress: normalizedAddr,
      mintFunctions: [],
      isVerified: false,
      abi: null,
      bytecode: null,
      isContract: false,
      warning: "No contract found at this address.",
    };
  }

  // Try fetching verified ABI from Basescan
  const { abi, isVerified } = await fetchContractAbi(normalizedAddr);

  let mintFunctions: MintFunctionInfo[] = [];

  if (abi) {
    mintFunctions = analyzeAbiForMintFunctions(abi);
  }

  // Fallback: analyze bytecode for known selectors
  if (mintFunctions.length === 0) {
    mintFunctions = analyzeBytecodeForMintSelectors(bytecode);
  }

  const freeMintFunctions = mintFunctions.filter((f) => f.isFreeMint && !f.requiresPayment);
  const paidFunctions = mintFunctions.filter((f) => f.requiresPayment);

  let warning: string | undefined;
  if (paidFunctions.length > 0 && freeMintFunctions.length === 0) {
    warning = "All detected mint functions require payment. Not a free mint.";
  } else if (mintFunctions.length === 0) {
    warning = "No standard mint functions detected. This may not be a mintable contract.";
  }

  return {
    contractAddress: normalizedAddr,
    mintFunctions: freeMintFunctions,
    isVerified,
    abi,
    bytecode,
    isContract: true,
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
    const abiItem = parseAbi([
      `function ${mintFunction.name}(${mintFunction.args.join(",")})`,
    ] as const);

    const data = encodeFunctionData({
      abi: abiItem,
      functionName: mintFunction.name,
    });

    // Simulate the call with value === 0n using eth_call to check for reverts
    await client.call({
      data: encodeFunctionData({ abi: abiItem, functionName: mintFunction.name }),
      to: contractAddress as Address,
      account: fromAddress as Address,
      value: 0n,
    } as any);

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export function getBestMintFunction(functions: MintFunctionInfo[]): MintFunctionInfo | null {
  // Prefer functions with no args (simplest)
  const noArg = functions.find((f) => f.args.length === 0);
  if (noArg) return noArg;
  // Then functions with uint256 arg
  const withArg = functions.find((f) => f.args.length === 1 && f.args[0] === "uint256");
  if (withArg) return withArg;
  return functions[0] || null;
}
