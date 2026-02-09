import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  PORT: z.coerce.number().default(4021),

  // x402 payment configuration
  PAYMENT_RECIPIENT_ADDRESS: z.string().startsWith("0x"),
  X402_NETWORK: z.string().default("eip155:8453"),
  CDP_API_KEY_ID: z.string().optional().transform((v) => v?.startsWith("your-") ? undefined : v),
  CDP_API_KEY_SECRET: z.string().optional().transform((v) => v?.startsWith("your-") ? undefined : v),

  // Pyth Pro — returned to buyer after purchase
  PYTH_PRO_ACCESS_TOKEN: z.string(),
  PYTH_PRO_WS_URLS: z
    .string()
    .default(
      "wss://pyth-lazer-0.dourolabs.app/v1/stream,wss://pyth-lazer-1.dourolabs.app/v1/stream,wss://pyth-lazer-2.dourolabs.app/v1/stream"
    )
    .transform((s) => s.split(",")),

  // Environment
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;

// The @coinbase/x402 library reads CDP keys directly from process.env at
// request time. Remove placeholder values so it falls back to unauthenticated
// requests (which work fine with the public Coinbase facilitator).
if (!config.CDP_API_KEY_ID) delete process.env.CDP_API_KEY_ID;
if (!config.CDP_API_KEY_SECRET) delete process.env.CDP_API_KEY_SECRET;
