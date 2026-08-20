export interface CollectionBid {
  id: string;
  priceEth: number;
  maker: string;
  validUntil: number;
}

export async function checkCollectionBids(contractAddress: string): Promise<CollectionBid[]> {
  const bids: CollectionBid[] = [];

  try {
    const res = await fetch(`https://api-base.reservoir.tools/orders/bids/v6?collection=${contractAddress}&status=active&limit=5`, {
      headers: {
        "Accept": "*/*",
      },
    });

    if (res.ok) {
      const data = (await res.json()) as any;
      if (data?.orders?.length > 0) {
        for (const order of data.orders) {
          const priceEth = order?.price?.amount?.native || 0;
          if (priceEth > 0) {
            bids.push({
              id: order.id,
              priceEth,
              maker: order.maker || "",
              validUntil: order.validUntil || 0,
            });
          }
        }
      }
    }
  } catch (err) {
    console.error(`Error checking collection bids for ${contractAddress}:`, err);
  }
  return bids;
}
