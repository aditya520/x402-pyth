import type { Request, Response } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { computePrice, getChannels } from "../pricing.js";
import { getTickerInfo, getTickersForAssetType } from "../symbols.js";

const logger = createLogger("purchase");

const purchaseBody = z.object({
  ticker: z.string().regex(/^[A-Z0-9]+-[A-Z]+$/),
});

export function purchaseHandler(assetType: string, channelSlug: string, duration: string) {
  return async (req: Request, res: Response): Promise<void> => {
    const parsed = purchaseBody.safeParse(req.body);
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

    const { ticker } = parsed.data;
    const tickerInfo = getTickerInfo(assetType, ticker);
    if (!tickerInfo) {
      const available = Object.keys(getTickersForAssetType(assetType));
      res.status(400).json({
        error: {
          code: "INVALID_TICKER",
          message: `Ticker '${ticker}' is not a valid ${assetType} ticker. Available: ${available.slice(0, 10).join(", ")}${available.length > 10 ? ` ... (${available.length} total)` : ""}`,
        },
      });
      return;
    }

    const price = computePrice(assetType, channelSlug, duration);
    const channels = getChannels();
    const wsChannel = channels[channelSlug]?.wsChannel ?? "fixed_rate@200ms";

    // Payment was already verified + settled by x402 middleware.
    // Extract payer wallet from x402 payment data.
    const payerWallet =
      (req as any).payerAddress ??
      (req.headers["x-payer-address"] as string) ??
      "unknown";

    // Audit trail via structured log
    logger.info(
      {
        wallet: payerWallet,
        ticker,
        feedId: tickerInfo.feedId,
        assetType,
        channel: channelSlug,
        duration,
        pricePaid: price?.formatted,
      },
      "Purchase completed"
    );

    res.json({
      ticker,
      feedId: tickerInfo.feedId,
      assetType,
      channel: channelSlug,
      duration,
      pricePaid: price?.formatted,
      pythPro: {
        accessToken: config.PYTH_PRO_ACCESS_TOKEN,
        websocketUrls: config.PYTH_PRO_WS_URLS,
        authMethod: "Pass as Authorization: Bearer {accessToken} header when connecting to WebSocket",
        subscribe: {
          type: "subscribe",
          subscriptionId: 1,
          priceFeedIds: [tickerInfo.feedId],
          properties: ["price", "bestBidPrice", "bestAskPrice", "exponent", "confidence"],
          formats: ["evm", "solana"],
          channel: wsChannel,
          deliveryFormat: "json",
          jsonBinaryEncoding: "hex",
        },
      },
    });
  };
}
