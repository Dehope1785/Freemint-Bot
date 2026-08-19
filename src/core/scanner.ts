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

// Comprehensive free-mint signatures for standard NFTs
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

// Check if the contract supports standard NFT functions (balanceOf, ownerOf, or tokenURI)
async function verifyIsNftContract(address: Address, abi: Abi): Promise<boolean> {
  const client = getPublicClient();
  
  // 1. Check ABI for standard NFT function names
  const hasNftFunctions = abi.some((item: any) => {
    if (item.type !== "function") return false;
    const name = item.name?.toLowerCase() || "";
    return name === "ownerof" || name === "tokenuri" || name === "safetransferfrom";
  });

  if (hasNftFunctions) return true;

  // 2. Fallback: Quick on-chain check using supportsInterface (ERC-165 for ERC-721 / ERC-1155)
  try {
    const supportsErc721 = await client.readContract({
      address,
      abi: parseAbi(["function supportsInterface(bytes4 interfaceId) view returns (bool)"]),
      functionName: "supportsInterface",
      args: ["0x80ac58cd"], // ERC-721 interface ID
    }).catch(() => false);

    const supportsErc1155 = await client.readContract({
      address,
      abi: parseAbi(["function supportsInterface(bytes4 interfaceId) view returns (bool)"]),
      functionName: "supportsInterface",
      args: ["0xd9b67a26"], // ERC-1155 interface ID
    }).catch(() => false);

    if (supportsErc721 || supportsErc1155) return true;
  } catch {
    // Ignore RPC failure on check
  }

  return false;
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

  if (!isVerified || !abi) {
    return {
      contractAddress: checksumAddress,
      mintFunctions: [],
      isVerified: false,
      abi,
      bytecode,
      isContract: true,
      security: { isSafe: false, isHoneypot: false, isDrainer: false, riskScore: 50, warnings: ["Unverified contract source"] },
      warning: "Skipped: Contract source code is unverified.",
    };
  }

  // === STRICT NFT FILTER: Reject tokens, pools, and non-NFT contracts ===
  const isNft = await verifyIsNftContract(checksumAddress, abi);
  if (!isNft) {
    return {
      contractAddress: checksumAddress,
      mintFunctions: [],
      isVerified,
      abi,
      bytecode,
      isContract: true,
      security: { isSafe: true, isHoneypot: false, isDrainer: false, riskScore: 10, warnings: ["Not an NFT contract"] },
      warning: "Skipped: Contract is a token/DeFi protocol, not an NFT collection.",
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

  const mintFunctions = analyzeAbiForMintFunctions(abi);
  const freeMintFunctions = mintFunctions.filter((f) => f.isFreeMint && !f.requiresPayment);

  if (freeMintFunctions.length === 0) {
    return {
      contractAddress: checksumAddress,
      mintFunctions: [],
      isVerified,
      abi,
      bytecode,
      isContract: true,
      security,
      warning: "Skipped: No valid free-mint function detected.",
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
