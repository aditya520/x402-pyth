# Pyth Pro x402 Gateway

Pay USDC, stream real-time price data.

An AI agent or developer hits a REST endpoint, pays via the x402 protocol (USDC on Base), and receives Pyth Pro credentials to connect directly to the Pyth Pro WebSocket for real-time price data at 200ms intervals with EVM and Solana payloads ready for on-chain submission. No forms, no sales cycle.

## How It Works

1. **Discover pricing** — `GET /v1/pricing` returns available tickers, durations, and prices
2. **Pay USDC via x402** — `POST /v1/purchase/:duration` triggers a 402 response; an x402-enabled client pays USDC on Base automatically
3. **Stream prices** — the purchase response includes Pyth Pro credentials, WebSocket URLs, and a ready-to-use subscribe message; connect directly to Pyth Pro

## Architecture

```
Agent/Client
    |
    |  1. GET /v1/pricing?ticker=BTC-USD        (free, returns price tiers)
    |  2. POST /v1/purchase/24h {ticker}         (x402: pay USDC, get Pyth Pro creds)
    |  3. Connect to Pyth Pro directly           (using returned credentials)
    |
    v
+--------------------+
|  Express Server    |
|                    |
|  x402 middleware   |
|  Purchase handler  |--------> Coinbase x402 Facilitator
|                    |          (payment settlement on Base L2)
+--------------------+
```

## Quick Start

### Prerequisites

- Node.js >= 22.14.0
- A Pyth Pro access token ([request here](https://docs.pyth.network/price-feeds/pro/getting-started))
- An EVM wallet address to receive USDC payments
- (Optional) Coinbase CDP API keys for mainnet x402 facilitator

### Setup

```bash
# Install dependencies
npm install

# Copy environment template and fill in your credentials
cp .env.example .env

# Start in development mode
npm run dev
```

The server starts on port 4021 by default.

## API Reference

### `GET /health`

Health check. No authentication.

```bash
curl http://localhost:4021/health
```

```json
{"status":"ok","timestamp":"2026-02-06T18:31:56.349Z","version":"0.1.0"}
```

### `GET /v1/pricing`

Returns available price tiers. No authentication. Optionally pass `?ticker=BTC-USD` to filter to a single ticker.

**All tickers:**

```bash
curl http://localhost:4021/v1/pricing
```

```json
{
  "pricing": [
    {
      "ticker": "BTC-USD",
      "feedId": 1,
      "durations": {
        "1h":  { "label": "1 hour",    "price": "$1.00",   "purchaseUrl": "/v1/purchase/1h" },
        "4h":  { "label": "4 hours",   "price": "$15.00",  "purchaseUrl": "/v1/purchase/4h" },
        "24h": { "label": "24 hours",  "price": "$25.00",  "purchaseUrl": "/v1/purchase/24h" },
        "7d":  { "label": "7 days",    "price": "$100.00", "purchaseUrl": "/v1/purchase/7d" },
        "30d": { "label": "30 days",   "price": "$300.00", "purchaseUrl": "/v1/purchase/30d" }
      }
    },
    { "ticker": "ETH-USD", "feedId": 2, "durations": { "..." : "..." } },
    { "ticker": "SOL-USD", "feedId": 6, "durations": { "..." : "..." } }
  ],
  "supportedTickers": ["BTC-USD", "ETH-USD", "SOL-USD"],
  "surgeMultiplier": 1,
  "instructions": "Purchase a duration via POST /v1/purchase/:duration with {\"ticker\":\"BTC-USD\"}. After x402 payment, the response includes Pyth Pro credentials and a ready-to-use subscribe message."
}
```

**Single ticker:**

```bash
curl "http://localhost:4021/v1/pricing?ticker=BTC-USD"
```

Returns the same shape but `pricing` is a single object instead of an array.

**Invalid ticker:**

```bash
curl "http://localhost:4021/v1/pricing?ticker=FAKE-USD"
```

```json
{
  "error": {
    "code": "INVALID_TICKER",
    "message": "Ticker 'FAKE-USD' is not supported. Available: BTC-USD, ETH-USD, SOL-USD"
  }
}
```

### `POST /v1/purchase/:duration`

x402-gated purchase endpoint. Duration must be one of: `1h`, `4h`, `24h`, `7d`, `30d`.

**Without payment:** returns HTTP 402 with payment instructions in the response headers.

```bash
# This will return 402 Payment Required (expected behavior)
curl -X POST http://localhost:4021/v1/purchase/1h \
  -H 'Content-Type: application/json' \
  -d '{"ticker":"BTC-USD"}'
```

**With valid x402 payment:** the x402 middleware verifies payment, then the handler returns Pyth Pro credentials:

```json
{
  "ticker": "BTC-USD",
  "feedId": 1,
  "duration": "1h",
  "pricePaid": 1,
  "pythPro": {
    "accessToken": "<pyth-pro-access-token>",
    "websocketUrls": [
      "wss://pyth-lazer-0.dourolabs.app/v1/stream",
      "wss://pyth-lazer-1.dourolabs.app/v1/stream",
      "wss://pyth-lazer-2.dourolabs.app/v1/stream"
    ],
    "authMethod": "Pass as Authorization: Bearer {accessToken} header when connecting to WebSocket",
    "subscribe": {
      "type": "subscribe",
      "subscriptionId": 1,
      "priceFeedIds": [1],
      "properties": ["price", "bestBidPrice", "bestAskPrice", "exponent", "confidence"],
      "formats": ["evm", "solana"],
      "channel": "fixed_rate@200ms",
      "deliveryFormat": "json",
      "jsonBinaryEncoding": "hex"
    }
  }
}
```

The agent then:
1. Connects to one of the `websocketUrls` with the `Authorization: Bearer {accessToken}` header
2. Sends the `subscribe` message verbatim over the WebSocket
3. Receives real-time price updates at 200ms intervals

## Supported Tickers

| Ticker | Pyth Feed ID |
|--------|-------------|
| BTC-USD | 1 |
| ETH-USD | 2 |
| SOL-USD | 6 |

## Pricing

| Duration | Price | Use Case |
|----------|-------|----------|
| 1 hour | $1.00 | Quick test, single trade |
| 4 hours | $15.00 | Trading session |
| 24 hours | $25.00 | Day trading, bots |
| 7 days | $100.00 | Strategy testing |
| 30 days | $300.00 | Production (small scale) |

Surge pricing (Phase 4) will apply multipliers from 1.0x to 2.0x based on active subscription count, with an optional 1.3x volatility multiplier. x402 pricing is intentionally premium over enterprise bundles to create a natural upgrade path.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `4021` | Server port |
| `PAYMENT_RECIPIENT_ADDRESS` | Yes | — | Your EVM wallet address (receives USDC) |
| `X402_NETWORK` | No | `eip155:8453` | CAIP-2 chain ID. Use `eip155:84532` for Base Sepolia testnet |
| `CDP_API_KEY_ID` | No | — | Coinbase Developer Platform API key ID (mainnet facilitator) |
| `CDP_API_KEY_SECRET` | No | — | CDP API key secret (mainnet facilitator) |
| `PYTH_PRO_ACCESS_TOKEN` | Yes | — | Pyth Pro (Lazer) access token |
| `PYTH_PRO_WS_URLS` | No | All 3 routers | Comma-separated Pyth Pro WebSocket URLs |
| `NODE_ENV` | No | `development` | `development`, `production`, or `test` |

For testnet, CDP keys are not required — the gateway automatically uses the public Coinbase facilitator at `x402.org`. For mainnet, provide CDP API keys to use the authenticated facilitator.

## E2E Testing

Two test scripts exercise the full payment + streaming flow:

**`test-purchase.ts`** — Simple purchase test with optional WebSocket verification:

```bash
TEST_PRIVATE_KEY=0x... npx tsx test-purchase.ts
```

**`test-agent.ts`** — Full end-to-end test (pricing → purchase → subscribe → price data):

```bash
TEST_PRIVATE_KEY=0x... npx tsx test-agent.ts
```

Both require a funded Base Sepolia wallet (get testnet USDC from https://faucet.circle.com/) and a running server (`npm run dev`).

See [TESTING.md](./TESTING.md) for the full testing guide including offline testing, unit tests, and LLM agent prompt testing results.

## Project Structure

```
src/
  index.ts              Entry point: HTTP server, graceful shutdown
  config.ts             Zod-validated environment variables
  server.ts             Express app: routes, x402 middleware, error handler
  logger.ts             Pino logger factory
  routes/
    health.ts           GET /health
    pricing.ts          GET /v1/pricing
    purchase.ts         POST /v1/purchase/:duration (x402-gated)

test-purchase.ts        E2E: single purchase + optional WS verification
test-agent.ts           E2E: full agent flow (pricing → purchase → stream)

prompts/                Discovery prompt set (agent gets only goal + URL + wallet)
prompts-explicit/       Explicit prompt set (agent gets endpoint paths + code examples)
.claude/agents/
  pyth-buyer.md         Autonomous agent config for LLM testing
```

## Architecture Decisions

- **No database** — purchases logged via structured pino logging (audit trail)
- **x402 payments** — USDC on Base via Coinbase x402 facilitator
- **Stateless** — no session store, no JWT (Phase 1); JWT and WS gateway planned for Phase 2
- **Premium pricing** — x402 instant access is intentionally more expensive than enterprise bundles to create a natural upgrade path
- **Public facilitator** — uses `x402.org` for testnet (no CDP keys needed), authenticated CDP facilitator for mainnet

## Roadmap

- **Phase 1 (MVP)**: x402 payment flow returns Pyth Pro credentials directly to buyer
- **Phase 2 (Gateway)**: JWT auth, WebSocket proxy gateway, upstream Pyth Pro connection
- **Phase 3 (Hardening)**: Health checks, rate limiting, monitoring
- **Phase 4 (Surge & Analytics)**: Redis, dynamic pricing, analytics dashboard
- **Phase 5 (SDK & Multi-Ticker)**: TypeScript SDK (npm), bundle purchases, docs

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with tsx |
| `npm run build` | Build for production with tsup |
| `npm start` | Run production build |
| `npm run typecheck` | TypeScript type checking |
| `npm test` | Run tests with vitest |
