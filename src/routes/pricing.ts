import { Router } from "express";
import { z } from "zod";
import {
  getAssetTypes,
  getChannels,
  getDurations,
  computePrice,
} from "../pricing.js";
import { getTickersForAssetType, getAllTickers } from "../symbols.js";

export const pricingRouter = Router();

const querySchema = z.object({
  ticker: z.string().optional(),
  assetType: z.string().optional(),
  channel: z.string().optional(),
});

pricingRouter.get("/", (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: parsed.error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", "),
      },
    });
    return;
  }

  const { ticker, assetType, channel } = parsed.data;
  const assetTypes = getAssetTypes();
  const channels = getChannels();
  const durations = getDurations();

  // Validate assetType if provided
  if (assetType && !assetTypes[assetType]) {
    res.status(400).json({
      error: {
        code: "INVALID_ASSET_TYPE",
        message: `Asset type '${assetType}' is not supported. Available: ${Object.keys(assetTypes).join(", ")}`,
      },
    });
    return;
  }

  // Validate channel if provided
  if (channel && !channels[channel]) {
    res.status(400).json({
      error: {
        code: "INVALID_CHANNEL",
        message: `Channel '${channel}' is not supported. Available: ${Object.keys(channels).join(", ")}`,
      },
    });
    return;
  }

  // Resolve which asset types to include
  const filteredAssetTypes = assetType ? [assetType] : Object.keys(assetTypes);

  // If ticker is provided, narrow to asset types that contain it
  let effectiveAssetTypes = filteredAssetTypes;
  if (ticker) {
    effectiveAssetTypes = filteredAssetTypes.filter((at) => {
      const tickers = getTickersForAssetType(at);
      return ticker in tickers;
    });
    if (effectiveAssetTypes.length === 0) {
      res.status(400).json({
        error: {
          code: "INVALID_TICKER",
          message: `Ticker '${ticker}' not found${assetType ? ` in asset type '${assetType}'` : ""}`,
        },
      });
      return;
    }
  }

  const filteredChannels = channel ? [channel] : Object.keys(channels);

  // Build pricing matrix
  const pricing: Array<{
    assetType: string;
    channel: string;
    duration: string;
    price: string;
    purchaseUrl: string;
  }> = [];

  for (const at of effectiveAssetTypes) {
    for (const ch of filteredChannels) {
      for (const dur of durations) {
        const p = computePrice(at, ch, dur.path);
        if (p) {
          pricing.push({
            assetType: at,
            channel: ch,
            duration: dur.path,
            price: p.formatted,
            purchaseUrl: `/v1/purchase/${at}/${ch}/${dur.path}`,
          });
        }
      }
    }
  }

  // Build supported tickers for the response
  const supportedTickers: Record<
    string,
    Record<string, { feedId: number }>
  > = {};
  const allTickers = getAllTickers();
  for (const at of effectiveAssetTypes) {
    const tickers = allTickers[at];
    if (!tickers) continue;
    if (ticker) {
      // Only include the requested ticker
      if (tickers[ticker]) {
        supportedTickers[at] = { [ticker]: { feedId: tickers[ticker].feedId } };
      }
    } else {
      supportedTickers[at] = Object.fromEntries(
        Object.entries(tickers).map(([t, info]) => [t, { feedId: info.feedId }])
      );
    }
  }

  res.json({
    assetTypes,
    channels,
    durations,
    pricing,
    supportedTickers,
    instructions:
      "Purchase access via POST /v1/purchase/:assetType/:channel/:duration with {\"ticker\":\"BTC-USD\"}. " +
      "After x402 payment, the response includes Pyth Pro credentials and a ready-to-use subscribe message.",
  });
});
