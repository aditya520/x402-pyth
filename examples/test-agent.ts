/**
 * Full end-to-end test: pricing → x402 purchase → WebSocket subscribe → price data.
 *
 * Prerequisites:
 *   1. Server running: npm run dev
 *   2. TEST_PRIVATE_KEY env var set to a funded Base Sepolia wallet
 *      (needs testnet USDC from https://faucet.circle.com/)
 *
 * Usage:
 *   TEST_PRIVATE_KEY=0x... npx tsx test-agent.ts
 */

import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const privateKey = process.env.TEST_PRIVATE_KEY;
if (!privateKey) {
  console.error("Set TEST_PRIVATE_KEY env var to a funded Base Sepolia wallet private key.");
  console.error("Usage: TEST_PRIVATE_KEY=0x... npx tsx test-agent.ts");
  process.exit(1);
}

const SERVER = process.env.SERVER_URL ?? "http://localhost:4021";
const TICKER = process.env.TICKER ?? "BTC-USD";
const DURATION = process.env.DURATION ?? "1h";
const WS_TIMEOUT = 10_000;

const account = privateKeyToAccount(privateKey as `0x${string}`);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
const x402Fetch = wrapFetchWithPayment(fetch, client);

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

console.log("=== Pyth Pro x402 E2E Test ===");
console.log(`Wallet:   ${account.address}`);
console.log(`Server:   ${SERVER}`);
console.log(`Ticker:   ${TICKER}`);
console.log(`Duration: ${DURATION}\n`);

// --- Step 1: GET /v1/pricing ---
console.log("Step 1: GET /v1/pricing");
const pricingRes = await fetch(`${SERVER}/v1/pricing?ticker=${TICKER}`);
assert(pricingRes.status === 200, "Pricing returns 200");

const pricingData = await pricingRes.json();
assert(!!pricingData.pricing, "Response has pricing object");
assert(
  Array.isArray(pricingData.supportedTickers) && pricingData.supportedTickers.includes(TICKER),
  `supportedTickers includes ${TICKER}`
);
assert(!!pricingData.pricing?.durations?.[DURATION], `Duration '${DURATION}' is listed`);
console.log(`  Tiers: ${Object.keys(pricingData.pricing.durations).join(", ")}`);
console.log(`  Price: ${pricingData.pricing.durations[DURATION].price}\n`);

// --- Step 2: POST /v1/purchase via x402 ---
console.log("Step 2: POST /v1/purchase (x402 payment)");
console.log("  Sending purchase request (x402 handles payment automatically)...");

const purchaseRes = await x402Fetch(`${SERVER}/v1/purchase/${DURATION}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ticker: TICKER }),
});

assert(purchaseRes.status === 200, "Purchase returns 200");

if (purchaseRes.status !== 200) {
  console.error("  Purchase failed:", await purchaseRes.text());
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(1);
}

const purchaseData = await purchaseRes.json();
assert(!!purchaseData.pythPro?.accessToken, "Response has accessToken");
assert(
  Array.isArray(purchaseData.pythPro?.websocketUrls) && purchaseData.pythPro.websocketUrls.length > 0,
  "Response has websocketUrls"
);
assert(!!purchaseData.pythPro?.subscribe, "Response has subscribe message");
console.log(`  Ticker: ${purchaseData.ticker}`);
console.log(`  Feed ID: ${purchaseData.feedId}`);
console.log(`  Paid: $${purchaseData.pricePaid}\n`);

// --- Step 3: Connect WebSocket ---
console.log("Step 3: WebSocket connect");
const wsUrl = purchaseData.pythPro.websocketUrls[0];
const accessToken = purchaseData.pythPro.accessToken;
console.log(`  URL: ${wsUrl}`);
console.log(`  Access token: ${accessToken.slice(0, 8)}...${accessToken.slice(-8)} (length=${accessToken.length})`);
console.log(`  Subscribe message: ${JSON.stringify(purchaseData.pythPro.subscribe)}`);

const ws = new WebSocket(wsUrl, {
  headers: { Authorization: `Bearer ${accessToken}` },
});

const wsResult = await new Promise<{ connected: boolean; subscribed: boolean; messages: any[] }>((resolve) => {
  let connected = false;
  let subscribed = false;
  const messages: any[] = [];

  const timeout = setTimeout(() => {
    ws.close();
    resolve({ connected, subscribed, messages });
  }, WS_TIMEOUT);

  ws.onopen = () => {
    connected = true;
    console.log("  Connected\n");

    // --- Step 4: Send subscribe ---
    console.log("Step 4: Send subscribe message");
    console.log(`  Subscription: feedIds=${JSON.stringify(purchaseData.pythPro.subscribe.priceFeedIds)}`);
    ws.send(JSON.stringify(purchaseData.pythPro.subscribe));
    subscribed = true;
    console.log("  Sent\n");

    console.log("Step 5: Wait for price updates...");
  };

  ws.onmessage = (event) => {
    const raw = typeof event.data === "string" ? event.data : event.data.toString();
    console.log(`  [WS message ${messages.length + 1}] ${raw}`);
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    messages.push(parsed);

    // Check for errors
    if (parsed?.type === "subscriptionError") {
      console.error(`\n  SUBSCRIPTION ERROR:`);
      console.error(`    ${JSON.stringify(parsed, null, 2)}`);
      clearTimeout(timeout);
      ws.close();
      resolve({ connected, subscribed, messages });
      return;
    }

    // Collect up to 3 price updates then stop
    const priceMessages = messages.filter((m) => m?.type === "streamUpdated");
    if (priceMessages.length >= 3) {
      clearTimeout(timeout);
      ws.close();
      resolve({ connected, subscribed, messages });
    }
  };

  ws.onerror = (event) => {
    console.error(`  WebSocket error: ${(event as any).message ?? "unknown"}`);
    clearTimeout(timeout);
    resolve({ connected, subscribed, messages });
  };
});

assert(wsResult.connected, "WebSocket connection opened");
assert(wsResult.subscribed, "Subscribe message sent");

const priceUpdates = wsResult.messages.filter((m) => m?.type === "streamUpdated");
const errors = wsResult.messages.filter((m) => m?.type === "subscriptionError");
assert(errors.length === 0, "No subscription errors", errors.length > 0 ? JSON.stringify(errors[0]) : undefined);
assert(priceUpdates.length > 0, `Received price updates (${priceUpdates.length})`, `got ${wsResult.messages.length} messages total`);

console.log(`\n  Total messages: ${wsResult.messages.length} (${priceUpdates.length} price updates, ${errors.length} errors)\n`);

// --- Step 6: Summary ---
console.log("Step 6: Summary");
console.log(`  Ticker:    ${purchaseData.ticker}`);
console.log(`  Duration:  ${purchaseData.duration}`);
console.log(`  Price:     $${purchaseData.pricePaid}`);
console.log(`  Feed ID:   ${purchaseData.feedId}`);
console.log(`  WS URLs:   ${purchaseData.pythPro.websocketUrls.length}`);
console.log(`  Messages:  ${wsResult.messages.length}`);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
