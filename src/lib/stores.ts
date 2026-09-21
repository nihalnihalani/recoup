export type StoreInfo = { name: string; kind: "retailer" | "marketplace"; note?: string };

const SELLERS_NOTE = "Individual sellers; prices vary by listing";

const KNOWN: Record<string, StoreInfo> = {
  "amazon.com": { name: "Amazon", kind: "marketplace", note: "Third-party sellers too; prices vary by listing" },
  "ebay.com": { name: "eBay", kind: "marketplace", note: SELLERS_NOTE },
  "facebook.com": { name: "Facebook Marketplace", kind: "marketplace", note: "Login-gated; often unreadable" },
  "etsy.com": { name: "Etsy", kind: "marketplace", note: SELLERS_NOTE },
  "mercari.com": { name: "Mercari", kind: "marketplace", note: SELLERS_NOTE },
  "aliexpress.com": { name: "AliExpress", kind: "marketplace", note: SELLERS_NOTE },
  "walmart.com": { name: "Walmart", kind: "retailer" },
  "target.com": { name: "Target", kind: "retailer" },
  "bestbuy.com": { name: "Best Buy", kind: "retailer" },
  "costco.com": { name: "Costco", kind: "retailer" },
  "homedepot.com": { name: "The Home Depot", kind: "retailer" },
  "lowes.com": { name: "Lowe's", kind: "retailer" },
  "newegg.com": { name: "Newegg", kind: "retailer" },
  "bhphotovideo.com": { name: "B&H Photo", kind: "retailer" },
  "nordstrom.com": { name: "Nordstrom", kind: "retailer" },
  "macys.com": { name: "Macy's", kind: "retailer" },
  "rei.com": { name: "REI", kind: "retailer" },
  "wayfair.com": { name: "Wayfair", kind: "retailer" },
  "apple.com": { name: "Apple", kind: "retailer" },
  "nike.com": { name: "Nike", kind: "retailer" },
  "adidas.com": { name: "Adidas", kind: "retailer" },
  "ikea.com": { name: "IKEA", kind: "retailer" },
  "kohls.com": { name: "Kohl's", kind: "retailer" },
  "gap.com": { name: "Gap", kind: "retailer" },
  "samsung.com": { name: "Samsung", kind: "retailer" },
  "dell.com": { name: "Dell", kind: "retailer" },
  "microcenter.com": { name: "Micro Center", kind: "retailer" },
  "sephora.com": { name: "Sephora", kind: "retailer" },
  "ulta.com": { name: "Ulta", kind: "retailer" },
  "chewy.com": { name: "Chewy", kind: "retailer" },
  "zappos.com": { name: "Zappos", kind: "retailer" },
  "staples.com": { name: "Staples", kind: "retailer" },
  "officedepot.com": { name: "Office Depot", kind: "retailer" },
  "dickssportinggoods.com": { name: "Dick's Sporting Goods", kind: "retailer" },
};

/** Second-level suffixes where the registrable name sits one label further left. */
const TWO_PART_SUFFIXES = new Set(["co.uk", "com.au", "co.jp", "com.br", "co.nz", "com.mx", "co.in", "co.kr"]);

/** "https://WWW.Shop.Example.com/x" → "shop.example.com". */
export function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^(www|m)\./, "");
}

/** Friendly name and kind for a store domain. Unknown stores get their capitalised registrable name. */
export function storeInfo(domain: string): StoreInfo {
  const host = normalizeDomain(domain);
  if (host.length === 0) return { name: "Unknown store", kind: "retailer" };
  // Match the host or any parent of it, so "smile.amazon.com" and "www.ebay.com" resolve.
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const known = KNOWN[labels.slice(i).join(".")];
    if (known) return known;
  }
  const suffixLabels = TWO_PART_SUFFIXES.has(labels.slice(-2).join(".")) ? 2 : 1;
  const registrable = labels[Math.max(0, labels.length - suffixLabels - 1)] ?? host;
  // Regional storefronts of a known store ("amazon.co.uk") keep its name and kind.
  const regional = KNOWN[`${registrable}.com`];
  if (regional) return regional;
  return { name: registrable.charAt(0).toUpperCase() + registrable.slice(1), kind: "retailer" };
}
