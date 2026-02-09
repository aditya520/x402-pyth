import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createLogger } from "./logger.js";

const logger = createLogger("pricing");

const pricingSchema = z.object({
  durations: z
    .array(
      z.object({
        path: z.string(),
        label: z.string(),
        basePriceDollars: z.number().positive(),
      })
    )
    .min(1, "At least one duration is required"),
  assetTypes: z
    .record(
      z.string(),
      z.object({ label: z.string(), multiplier: z.number().positive() })
    )
    .refine((obj) => Object.keys(obj).length > 0, {
      message: "At least one asset type is required",
    }),
  channels: z
    .record(
      z.string(),
      z.object({
        label: z.string(),
        wsChannel: z.string(),
        multiplier: z.number().positive(),
      })
    )
    .refine((obj) => Object.keys(obj).length > 0, {
      message: "At least one channel is required",
    }),
});

export type PricingConfig = z.infer<typeof pricingSchema>;

export interface RouteConfig {
  routePath: string;
  price: string;
  assetType: string;
  channel: string;
  duration: string;
}

const PRICING_FILE = path.resolve(import.meta.dirname, "..", "pricing.json");

let current: PricingConfig | null = null;

function loadConfig(): PricingConfig | null {
  try {
    const raw = fs.readFileSync(PRICING_FILE, "utf-8");
    const parsed = pricingSchema.parse(JSON.parse(raw));
    logger.info(
      {
        durations: parsed.durations.length,
        assetTypes: Object.keys(parsed.assetTypes).length,
        channels: Object.keys(parsed.channels).length,
      },
      "Pricing config loaded"
    );
    return parsed;
  } catch (err) {
    logger.error({ err }, "Failed to load pricing.json");
    return null;
  }
}

// Initial load — must succeed or we can't start
current = loadConfig();
if (!current) {
  throw new Error("pricing.json is missing or invalid — cannot start server");
}

// Watch for changes and hot-reload
try {
  fs.watch(PRICING_FILE, (eventType) => {
    if (eventType === "change") {
      const updated = loadConfig();
      if (updated) {
        current = updated;
      } else {
        logger.warn("Invalid pricing.json update ignored — keeping previous config");
      }
    }
  });
} catch {
  logger.warn("Could not watch pricing.json for changes — hot-reload disabled");
}

export function getPricing(): PricingConfig {
  return current!;
}

export function getAssetTypes() {
  return getPricing().assetTypes;
}

export function getChannels() {
  return getPricing().channels;
}

export function getDurations() {
  return getPricing().durations;
}

export function computePrice(
  assetType: string,
  channel: string,
  durationPath: string
): { dollars: number; formatted: string } | undefined {
  const cfg = getPricing();
  const at = cfg.assetTypes[assetType];
  const ch = cfg.channels[channel];
  const dur = cfg.durations.find((d) => d.path === durationPath);
  if (!at || !ch || !dur) return undefined;

  const dollars = dur.basePriceDollars * at.multiplier * ch.multiplier;
  // Round to 2 decimal places
  const rounded = Math.round(dollars * 100) / 100;
  return { dollars: rounded, formatted: `$${rounded.toFixed(2)}` };
}

export function getAllRouteConfigs(): RouteConfig[] {
  const cfg = getPricing();
  const routes: RouteConfig[] = [];
  for (const assetType of Object.keys(cfg.assetTypes)) {
    for (const channel of Object.keys(cfg.channels)) {
      for (const dur of cfg.durations) {
        const price = computePrice(assetType, channel, dur.path);
        if (price) {
          routes.push({
            routePath: `/v1/purchase/${assetType}/${channel}/${dur.path}`,
            price: price.formatted,
            assetType,
            channel,
            duration: dur.path,
          });
        }
      }
    }
  }
  return routes;
}
