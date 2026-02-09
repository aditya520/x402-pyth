# Testing Guide

This document covers how to test every component of the Pyth Pro x402 Gateway.

## 1. Prerequisites

```bash
npm install
```

## 2. Type Checking

Verify the entire codebase compiles without errors:

```bash
npm run typecheck
```

Expected: no output (clean compile).

## 3. Testing Without Credentials (Offline)

You can test most of the gateway without real Pyth Pro or x402 credentials.

### 3a. Start the Server

Create a `.env` file with minimal test values:

```bash
cat > .env << 'EOF'
PORT=4021
NODE_ENV=development
PAYMENT_RECIPIENT_ADDRESS=0x0000000000000000000000000000000000000001
X402_NETWORK=eip155:84532
PYTH_PRO_ACCESS_TOKEN=test-token
EOF
```

Start the server:

```bash
npm run dev
```

The server will start and all HTTP routes will work.

### 3b. Health Check

```bash
curl http://localhost:4021/health
```

Expected:
```json
{"status":"ok","timestamp":"...","version":"0.1.0"}
```

### 3c. Pricing Endpoint

Get all tickers:
```bash
curl http://localhost:4021/v1/pricing
```

Get a specific ticker:
```bash
curl "http://localhost:4021/v1/pricing?ticker=BTC-USD"
```

Test invalid ticker:
```bash
curl "http://localhost:4021/v1/pricing?ticker=FAKE-USD"
# Returns 400 with error
```

### 3d. Purchase Endpoint (402 Response)

```bash
curl -v -X POST http://localhost:4021/v1/purchase/1h \
  -H 'Content-Type: application/json' \
  -d '{"ticker":"BTC-USD"}'
```

Expected: The x402 middleware intercepts this and returns a 402 with payment instructions in the `PAYMENT-REQUIRED` header (or an error if the facilitator can't be reached with test credentials).

## 4. Testing With Real Credentials

To test the full end-to-end flow including actual payment:

### 4a. Get Real Credentials

1. **Pyth Pro token**: Contact a Pyth data distributor at https://docs.pyth.network/price-feeds/pro/getting-started
2. **x402 facilitator**: For testnet, the public facilitator at `https://x402.org/facilitator` works. For mainnet, get CDP API keys at https://portal.cdp.coinbase.com/

### 4b. Update .env

```bash
PYTH_PRO_ACCESS_TOKEN=<real-token>
PAYMENT_RECIPIENT_ADDRESS=<your-real-wallet>
X402_NETWORK=eip155:84532  # Base Sepolia for testing
```

### 4c. Start and Test

```bash
npm run dev
```

## 5. Testing the x402 Payment Flow

The full x402 flow requires an x402-enabled HTTP client with a funded wallet. Here's how to test with the `@x402/fetch` client:

```typescript
// test-purchase.ts
import { wrapFetch } from "@x402/fetch";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const account = privateKeyToAccount("0x<your-private-key>");
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(),
});

const x402Fetch = wrapFetch(fetch, walletClient);

// This will automatically handle the 402 -> pay -> retry flow
const res = await x402Fetch("http://localhost:4021/v1/purchase/1h", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ticker: "BTC-USD" }),
});

const data = await res.json();
console.log("Pyth Pro credentials:", data.pythPro);
console.log("Connect to:", data.pythPro.websocketUrls[0]);
console.log("Send subscribe:", JSON.stringify(data.pythPro.subscribe));
```

## 6. Purchase Audit Trail

Purchases are logged via structured pino logging instead of a database. To inspect purchase records, check the server's stdout/logs for entries with `"msg":"Purchase completed"`:

```bash
# When running in development, pino-pretty formats the output
npm run dev

# In production, pipe JSON logs to jq:
node dist/index.js | jq 'select(.msg == "Purchase completed")'
```

## 7. Unit Tests (vitest)

The project is configured for vitest. To add and run tests:

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch
```

## 8. Quick Smoke Test Script

Run all the offline tests in sequence:

```bash
#!/bin/bash
set -e

echo "=== Type Check ==="
npm run typecheck

echo "=== Start Server ==="
PAYMENT_RECIPIENT_ADDRESS=0x0000000000000000000000000000000000000001 \
PYTH_PRO_ACCESS_TOKEN=test-token \
npm run dev &
SERVER_PID=$!
sleep 3

echo "=== Health Check ==="
curl -sf http://localhost:4021/health | jq .

echo "=== Pricing ==="
curl -sf "http://localhost:4021/v1/pricing?ticker=BTC-USD" | jq .

echo "=== Purchase (402) ==="
STATUS=$(curl -so /dev/null -w '%{http_code}' -X POST http://localhost:4021/v1/purchase/1h \
  -H 'Content-Type: application/json' \
  -d '{"ticker":"BTC-USD"}')
echo "Purchase returned: $STATUS (expect 402)"

echo "=== Cleanup ==="
kill $SERVER_PID 2>/dev/null
echo "Done!"
```

## 9. LLM Agent Prompt Testing

### Overview

Two prompt sets test whether LLM agents can autonomously use the gateway to discover pricing, purchase access, and stream real-time price data — without any human intervention.

### Prompt Sets

- **`prompts/`** (discovery): The agent receives only a goal, the server URL, and a wallet private key. It must discover the API, understand the x402 payment protocol, find the right SDK, and complete the task autonomously.
- **`prompts-explicit/`**: The agent receives endpoint paths, protocol names, code examples, and step-by-step instructions. Tests whether explicit guidance reduces cost and latency.

Both sets include 5 scenarios: Unknown Ticker, Arbitrage Bot, Portfolio Monitor, Cost-Conscious Agent, and Multi-Asset Researcher.

### Agent Configuration

The agent is configured in `.claude/agents/pyth-buyer.md` — an autonomous Claude Code agent with access to bash tools (curl, jq, node, npx, tsx, npm) and web search. It reads `$SERVER_URL` and `$TEST_PRIVATE_KEY` from the environment.

### How to Run

Start the server, then run a scenario with the pyth-buyer agent:

```bash
# Discovery prompt (agent figures everything out)
SERVER_URL=http://localhost:4021 TEST_PRIVATE_KEY=0x... \
  claude --agent .claude/agents/pyth-buyer.md \
  "$(sed "s|{SERVER_URL}|$SERVER_URL|g" prompts/arbitrage-bot.md)"

# Explicit prompt (agent gets step-by-step instructions)
SERVER_URL=http://localhost:4021 TEST_PRIVATE_KEY=0x... \
  claude --agent .claude/agents/pyth-buyer.md \
  "$(sed "s|{SERVER_URL}|$SERVER_URL|g" prompts-explicit/arbitrage-bot.md)"
```

### Results Summary

All 5 scenarios were tested with both prompt sets on Base Sepolia testnet with real x402 payments:

| Scenario | Discovery | Explicit | Notes |
|----------|-----------|----------|-------|
| Unknown Ticker | Pass (15 calls, 63s, 29.7k tokens) | Pass (3 calls, 23s, 19.2k tokens) | No payment needed — agent correctly identifies unsupported ticker |
| Arbitrage Bot | Pass (28 calls, 3m23s, 42.6k tokens) | Pass (15 calls, 2m06s, 27.6k tokens) | Full e2e: purchase + WebSocket streaming of 3 price updates |
| Portfolio Monitor | Pass (38 calls, 34m40s, 66.2k tokens) | Partial (19 calls, 32m42s, 35.1k tokens) | Explicit hit sender==recipient x402 error |
| Cost-Conscious | Pass (40 calls, 33m25s, 62.1k tokens) | Pass (20 calls, 33m52s, 28.8k tokens) | Budget math correct — agent chooses cheapest tier |
| Multi-Asset | Pass (26 calls, 28m55s, 47.5k tokens) | Pass (19 calls, 33m23s, 31.5k tokens) | 3 separate purchases, formatted table output |

### Key Findings

- **Discovery agents use ~2x more tokens** but reach the same outcomes. The extra cost comes from API exploration, web searches for x402 SDK documentation, and trial-and-error.
- **All 5 discovery scenarios passed** (10/10 success criteria met). Discovery agents autonomously found the `@x402/fetch` SDK from 402 responses and web search, installed it, and completed payments.
- **Explicit agents are faster for known workflows** — roughly half the API calls and tokens when the agent already knows the endpoint paths and x402 protocol.
- **Portfolio Monitor (explicit) was a partial pass** — the agent completed the purchase but hit a `sender==recipient` error during x402 payment for one of the tickers, likely due to the test wallet being the same as the payment recipient address.
- **Long-running scenarios (30+ minutes)** are dominated by WebSocket streaming time, not agent reasoning. The agent spends most of its time waiting for price updates to arrive.
