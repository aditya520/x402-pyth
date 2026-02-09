import { createLogger } from "./logger.js";
import { getAssetTypes } from "./pricing.js";

const logger = createLogger("symbols");

const SYMBOLS_API_URL =
  "https://history.pyth-lazer.dourolabs.app/history/v1/symbols";

/** Maps API `asset_type` values to our pricing config keys. */
const ASSET_TYPE_MAP: Record<string, string> = {
  crypto: "crypto",
  equity: "equity",
  fx: "fx",
  rates: "rates",
  commodity: "commodity",
  kalshi: "kalshi",
  nav: "nav",
  metal: "commodity", // metals are commodities
};

export interface TickerInfo {
  feedId: number;
  assetType: string;
}

// Nested map: assetType → ticker → TickerInfo
let byAssetType: Record<string, Record<string, TickerInfo>> = {};

/**
 * Derive a human-readable ticker from the Pyth symbol string.
 *   "Crypto.BTC/USD"         → "BTC-USD"
 *   "Equity.US.AAPL/USD"     → "AAPL-USD"
 *   "FX.AUD/NZD"             → "AUD-NZD"
 *   "Metal.XAG/USD"          → "XAG-USD"
 *   "Crypto.NAV.ACRED/USD"   → "ACRED-USD"
 */
function parseTickerName(symbol: string): string | null {
  const slashIdx = symbol.indexOf("/");
  if (slashIdx === -1) return null;
  const prefix = symbol.substring(0, slashIdx);
  const quote = symbol.substring(slashIdx + 1);
  const dotIdx = prefix.lastIndexOf(".");
  if (dotIdx === -1) return null;
  const base = prefix.substring(dotIdx + 1);
  if (!base || !quote) return null;
  return `${base}-${quote}`;
}

/** Fetch symbols from the Pyth Lazer API and cache locally. */
export async function initSymbols(): Promise<void> {
  const res = await fetch(SYMBOLS_API_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch symbols: ${res.status} ${res.statusText}`
    );
  }
  const data: any[] = await res.json();

  const assetTypes = getAssetTypes();
  const map: Record<string, Record<string, TickerInfo>> = {};

  for (const item of data) {
    if (item.state !== "stable") continue;

    const mappedType = ASSET_TYPE_MAP[item.asset_type];
    if (!mappedType || !assetTypes[mappedType]) continue;

    const ticker = parseTickerName(item.symbol);
    if (!ticker) continue;

    if (!map[mappedType]) map[mappedType] = {};

    // First-seen wins (avoids overwriting e.g. crypto BTC-USD with a funding-rate BTC-USD)
    if (!map[mappedType][ticker]) {
      map[mappedType][ticker] = {
        feedId: item.pyth_lazer_id,
        assetType: mappedType,
      };
    }
  }

  byAssetType = map;
  const total = Object.values(map).reduce(
    (sum, m) => sum + Object.keys(m).length,
    0
  );
  logger.info(
    {
      total,
      byType: Object.fromEntries(
        Object.entries(map).map(([k, v]) => [k, Object.keys(v).length])
      ),
    },
    "Symbols loaded from API"
  );
}

/** Look up a single ticker within an asset type. */
export function getTickerInfo(
  assetType: string,
  ticker: string
): TickerInfo | undefined {
  return byAssetType[assetType]?.[ticker];
}

/** All tickers for a given asset type (empty object if none). */
export function getTickersForAssetType(
  assetType: string
): Record<string, TickerInfo> {
  return byAssetType[assetType] ?? {};
}

/** Full nested map of all tickers. */
export function getAllTickers(): Record<string, Record<string, TickerInfo>> {
  return byAssetType;
}
