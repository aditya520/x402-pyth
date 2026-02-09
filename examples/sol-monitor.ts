/**
 * SOL-USD Price Monitor Agent
 *
 * Full flow:
 *   1. Discover API at the Pyth x402 Gateway
 *   2. Purchase cheapest SOL-USD access (1h @ $1 USDC) via x402 protocol
 *   3. Connect to Pyth Pro WebSocket
 *   4. Stream SOL-USD prices and alert if price drops below $150
 *
 * Usage:
 *   TEST_PRIVATE_KEY=0x... npx tsx sol-monitor.ts
 */

import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

// ---------- Configuration ----------
const SERVER = process.env.SERVER_URL ?? "http://localhost:4021";
const TICKER = "SOL-USD";
const DURATION = "1h"; // cheapest option at $1
const ALERT_THRESHOLD = 150; // USD
const HOLDINGS = 50; // SOL
const MAX_UPDATES = 20; // stop after N price updates for demo purposes

// ---------- Wallet Setup ----------
const privateKey = process.env.TEST_PRIVATE_KEY;
if (!privateKey) {
  console.error("ERROR: Set TEST_PRIVATE_KEY env var to a funded Base Sepolia wallet private key.");
  console.error("Usage: TEST_PRIVATE_KEY=0x... npx tsx sol-monitor.ts");
  process.exit(1);
}

const account = privateKeyToAccount(privateKey as `0x${string}`);
console.log("=== SOL-USD Price Monitor Agent ===\n");
console.log(`Wallet:    ${account.address}`);
console.log(`Server:    ${SERVER}`);
console.log(`Ticker:    ${TICKER}`);
console.log(`Duration:  ${DURATION}`);
console.log(`Threshold: $${ALERT_THRESHOLD}`);
console.log(`Holdings:  ${HOLDINGS} SOL\n`);

// ---------- Step 1: Discover Pricing ----------
console.log("--- Step 1: Discover Pricing ---");

const pricingRes = await fetch(`${SERVER}/v1/pricing`);
if (!pricingRes.ok) {
  console.error(`Failed to fetch pricing: HTTP ${pricingRes.status}`);
  process.exit(1);
}
const pricingData = await pricingRes.json();

// Find SOL-USD pricing
const solPricing = pricingData.pricing.find((p: any) => p.ticker === TICKER);
if (!solPricing) {
  console.error(`${TICKER} not found in available tickers: ${pricingData.supportedTickers.join(", ")}`);
  process.exit(1);
}

console.log(`Available tickers: ${pricingData.supportedTickers.join(", ")}`);
console.log(`SOL-USD feed ID: ${solPricing.feedId}`);
console.log(`Available durations:`);
for (const [dur, info] of Object.entries(solPricing.durations) as any) {
  console.log(`  ${dur}: ${info.price}${dur === DURATION ? " <-- selected (cheapest)" : ""}`);
}
console.log(`Surge multiplier: ${pricingData.surgeMultiplier}x`);
console.log(`Instructions: ${pricingData.instructions}\n`);

// ---------- Step 2: Purchase via x402 ----------
console.log("--- Step 2: Purchase SOL-USD Access via x402 ---");

const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const x402Fetch = wrapFetchWithPayment(fetch, client);

console.log(`Purchasing ${DURATION} access to ${TICKER}...`);
console.log(`(x402 will handle USDC payment on Base Sepolia automatically)\n`);

const purchaseRes = await x402Fetch(`${SERVER}/v1/purchase/${DURATION}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ticker: TICKER }),
});

console.log(`HTTP ${purchaseRes.status}`);

if (!purchaseRes.ok) {
  const errorText = await purchaseRes.text();
  console.error(`Purchase failed: ${errorText}`);
  process.exit(1);
}

const purchaseData = await purchaseRes.json();
console.log("Purchase successful!\n");
console.log(`  Ticker:    ${purchaseData.ticker}`);
console.log(`  Feed ID:   ${purchaseData.feedId}`);
console.log(`  Duration:  ${purchaseData.duration}`);
console.log(`  Price:     $${purchaseData.pricePaid} USDC`);
console.log(`  WS URLs:   ${purchaseData.pythPro.websocketUrls.length} endpoints`);
console.log(`  Token:     ${purchaseData.pythPro.accessToken.slice(0, 12)}...`);
console.log();

// ---------- Step 3: Connect to Pyth Pro WebSocket ----------
console.log("--- Step 3: Connect to Pyth Pro WebSocket ---");

const wsUrl = purchaseData.pythPro.websocketUrls[0];
const accessToken = purchaseData.pythPro.accessToken;
const subscribeMsg = purchaseData.pythPro.subscribe;

console.log(`Connecting to: ${wsUrl}`);

const ws = new WebSocket(wsUrl, {
  headers: { Authorization: `Bearer ${accessToken}` },
});

// ---------- Step 4: Monitor Prices ----------
const result = await new Promise<{
  connected: boolean;
  prices: { price: number; timestamp: string; alert: boolean }[];
  error?: string;
}>((resolve) => {
  let connected = false;
  const prices: { price: number; timestamp: string; alert: boolean }[] = [];

  // 60 second timeout
  const timeout = setTimeout(() => {
    ws.close();
    resolve({ connected, prices });
  }, 60_000);

  ws.onopen = () => {
    connected = true;
    console.log("Connected to Pyth Pro WebSocket!\n");

    // Send subscribe message
    console.log("--- Step 4: Subscribe & Monitor SOL-USD Prices ---");
    console.log(`Subscribing to feed IDs: ${JSON.stringify(subscribeMsg.priceFeedIds)}`);
    console.log(`Channel: ${subscribeMsg.channel}`);
    console.log(`Alert threshold: SOL-USD < $${ALERT_THRESHOLD}\n`);

    ws.send(JSON.stringify(subscribeMsg));
  };

  ws.onmessage = (event) => {
    const raw = typeof event.data === "string" ? event.data : event.data.toString();

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.log(`[Raw message] ${raw.slice(0, 200)}`);
      return;
    }

    // Handle subscription errors
    if (parsed?.type === "subscriptionError") {
      console.error(`SUBSCRIPTION ERROR: ${JSON.stringify(parsed)}`);
      clearTimeout(timeout);
      ws.close();
      resolve({ connected, prices, error: JSON.stringify(parsed) });
      return;
    }

    // Handle subscription confirmation
    if (parsed?.type === "subscribed") {
      console.log(`Subscription confirmed: ${JSON.stringify(parsed)}\n`);
      return;
    }

    // Handle price updates
    if (parsed?.type === "streamUpdated") {
      // Extract price from the parsed data
      // Structure: { type: "streamUpdated", parsed: { timestampUs, priceFeeds: [{ priceFeedId, price, exponent, ... }] } }
      const parsedData = parsed?.parsed;
      const priceFeeds = parsedData?.priceFeeds;
      let extracted = false;

      if (priceFeeds && Array.isArray(priceFeeds)) {
        for (const pf of priceFeeds) {
          const priceRaw = pf?.price;
          const exponent = pf?.exponent;
          if (priceRaw !== undefined && exponent !== undefined) {
            // Price is in fixed point; adjust by exponent
            // e.g., price=8796602847 with exponent=-8 means $87.96602847
            const actualPrice = Number(BigInt(priceRaw)) * Math.pow(10, exponent);

            const isAlert = actualPrice < ALERT_THRESHOLD;
            const timestamp = new Date().toISOString();

            prices.push({ price: actualPrice, timestamp, alert: isAlert });
            extracted = true;

            const portfolioValue = (HOLDINGS * actualPrice).toFixed(2);
            const status = isAlert ? "ALERT" : "OK";

            console.log(
              `[${timestamp}] SOL-USD: $${actualPrice.toFixed(4)} | ` +
                `Portfolio: ${HOLDINGS} SOL = $${portfolioValue} | ` +
                `Status: ${status}${isAlert ? ` -- BELOW $${ALERT_THRESHOLD} THRESHOLD!` : ""}`
            );

            if (isAlert) {
              console.log(
                `\n  *** PRICE ALERT ***\n` +
                  `  SOL-USD has dropped to $${actualPrice.toFixed(4)}\n` +
                  `  Your ${HOLDINGS} SOL portfolio is now worth $${portfolioValue}\n` +
                  `  This is below your $${ALERT_THRESHOLD} threshold.\n` +
                  `  Consider taking action!\n`
              );
            }
          }
        }
      }

      // If we couldn't extract a price, log raw for debugging
      if (!extracted) {
        console.log(`[Price Update - raw] ${JSON.stringify(parsed).slice(0, 500)}`);
      }

      // Stop after MAX_UPDATES price updates
      if (prices.length >= MAX_UPDATES) {
        clearTimeout(timeout);
        ws.close();
        resolve({ connected, prices });
      }
    } else if (parsed?.type !== "subscribed") {
      // Log unknown message types
      console.log(`[${parsed?.type ?? "unknown"}] ${JSON.stringify(parsed).slice(0, 300)}`);
    }
  };

  ws.onerror = (event) => {
    console.error(`WebSocket error: ${(event as any).message ?? "unknown"}`);
    clearTimeout(timeout);
    resolve({ connected, prices, error: (event as any).message ?? "unknown" });
  };

  ws.onclose = () => {
    if (prices.length < MAX_UPDATES) {
      // Connection closed before we got enough updates
      clearTimeout(timeout);
      resolve({ connected, prices });
    }
  };
});

// ---------- Step 5: Summary ----------
console.log("\n--- Summary ---");
console.log(`Connected:       ${result.connected ? "Yes" : "No"}`);
console.log(`Price updates:   ${result.prices.length}`);

if (result.prices.length > 0) {
  const priceValues = result.prices.map((p) => p.price);
  const minPrice = Math.min(...priceValues);
  const maxPrice = Math.max(...priceValues);
  const avgPrice = priceValues.reduce((a, b) => a + b, 0) / priceValues.length;
  const alerts = result.prices.filter((p) => p.alert).length;

  console.log(`Min price:       $${minPrice.toFixed(4)}`);
  console.log(`Max price:       $${maxPrice.toFixed(4)}`);
  console.log(`Avg price:       $${avgPrice.toFixed(4)}`);
  console.log(`Alerts (<$${ALERT_THRESHOLD}): ${alerts}`);
  console.log(`Current value:   ${HOLDINGS} SOL = $${(HOLDINGS * priceValues[priceValues.length - 1]).toFixed(2)}`);

  if (alerts > 0) {
    console.log(`\nWARNING: SOL-USD dropped below $${ALERT_THRESHOLD} during monitoring!`);
  } else {
    console.log(`\nAll clear: SOL-USD stayed above $${ALERT_THRESHOLD} during monitoring.`);
  }
} else {
  console.log("No price data received.");
}

if (result.error) {
  console.log(`Error: ${result.error}`);
}

console.log("\nDone.");
