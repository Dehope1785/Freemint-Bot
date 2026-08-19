let cachedPrice = 0;
let lastFetch = 0;

export async function getEthUsdPrice(): Promise<number> {
  const now = Date.now();
  // Cache price for 60 seconds
  if (cachedPrice > 0 && now - lastFetch < 60_000) {
    return cachedPrice;
  }

  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    const data = (await res.json()) as any;
    if (data.ethereum?.usd) {
      cachedPrice = data.ethereum.usd;
      lastFetch = now;
      return cachedPrice;
    }
  } catch {
    if (cachedPrice > 0) return cachedPrice;
  }

  return 3000; // Baseline fallback
}

export async function ethToUsd(ethAmount: number): Promise<number> {
  const price = await getEthUsdPrice();
  return ethAmount * price;
}

export async function usdToEth(usdAmount: number): Promise<number> {
  const price = await getEthUsdPrice();
  return usdAmount / price;
}
