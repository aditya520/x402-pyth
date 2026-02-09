/**
 * End-to-end test: purchase Pyth Pro access via x402 on Base Sepolia testnet.
 *
 * Prerequisites:
 *   1. Server running: npm run dev
 *   2. TEST_PRIVATE_KEY env var set to a funded Base Sepolia wallet
 *      (needs testnet USDC from https://faucet.circle.com/)
 *
 * Usage:
 *   TEST_PRIVATE_KEY=0x... npx tsx test-purchase.ts
 */

import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const privateKey = process.env.TEST_PRIVATE_KEY;
if (!privateKey) {
  console.error("Set TEST_PRIVATE_KEY env var to a funded Base Sepolia wallet private key.");
  console.error("Usage: TEST_PRIVATE_KEY=0x... npx tsx test-purchase.ts");
  process.exit(1);
}

const account = privateKeyToAccount(privateKey as `0x${string}`);

const client = new x402Client();
registerExactEvmScheme(client, { signer: account });

const x402Fetch = wrapFetchWithPayment(fetch, client);

const SERVER = process.env.SERVER_URL ?? "http://localhost:4021";
const DURATION = "1h"; // cheapest tier ($5)
const TICKER = "BTC-USD";

console.log(`Wallet:   ${account.address}`);
console.log(`Server:   ${SERVER}`);
console.log(`Purchase: ${DURATION} of ${TICKER}\n`);

console.log("Sending purchase request (x402 will handle payment automatically)...\n");

const res = await x402Fetch(`${SERVER}/v1/purchase/${DURATION}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ticker: TICKER }),
});

console.log(`HTTP ${res.status}\n`);

if (!res.ok) {
  console.error("Purchase failed:", await res.text());
  process.exit(1);
}

const data = await res.json();
console.log("Purchase successful!\n");
console.log(JSON.stringify(data, null, 2));

// --- Optional WebSocket verification ---
const VERIFY_WS = process.env.VERIFY_WS !== "false"; // enabled by default, set VERIFY_WS=false to skip

if (VERIFY_WS && data.pythPro?.websocketUrls?.length && data.pythPro?.accessToken) {
  console.log("\n--- WebSocket Verification ---");
  const wsUrl = data.pythPro.websocketUrls[0];
  console.log(`Connecting to: ${wsUrl}`);

  const ws = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${data.pythPro.accessToken}` },
  });

  const result = await new Promise<{ ok: boolean; message?: string }>((resolve) => {
    const timeout = setTimeout(() => {
      ws.close();
      resolve({ ok: false, message: "Timeout (10s) — no message received" });
    }, 10_000);

    ws.onopen = () => {
      console.log("Connected. Sending subscribe message...");
      ws.send(JSON.stringify(data.pythPro.subscribe));
    };

    ws.onmessage = (event) => {
      const msg = typeof event.data === "string" ? event.data : event.data.toString();
      clearTimeout(timeout);
      ws.close();
      resolve({ ok: true, message: msg });
    };

    ws.onerror = (event) => {
      clearTimeout(timeout);
      resolve({ ok: false, message: `WebSocket error: ${(event as any).message ?? "unknown"}` });
    };
  });

  if (result.ok) {
    console.log("WebSocket verification PASSED");
    try {
      const parsed = JSON.parse(result.message!);
      console.log(`First message: ${JSON.stringify(parsed).slice(0, 200)}...`);
    } catch {
      console.log(`First message (raw): ${result.message!.slice(0, 200)}...`);
    }
  } else {
    console.error(`WebSocket verification FAILED: ${result.message}`);
  }
} else if (!VERIFY_WS) {
  console.log("\n--- WebSocket verification skipped (VERIFY_WS=false) ---");
}

console.log("\n--- Next steps ---");
console.log(`1. Connect to: ${data.pythPro.websocketUrls[0]} (with Authorization: Bearer {accessToken} header)`);
console.log(`2. Send subscribe message: ${JSON.stringify(data.pythPro.subscribe)}`);
