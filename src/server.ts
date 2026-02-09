import express from "express";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { config } from "./config.js";
import { pricingRouter } from "./routes/pricing.js";
import { healthRouter } from "./routes/health.js";
import { purchaseHandler } from "./routes/purchase.js";
import { createLogger } from "./logger.js";
import { getAllRouteConfigs } from "./pricing.js";

const logger = createLogger("server");

export function createApp() {
  const app = express();
  app.use(express.json());

  // Unprotected routes
  app.use("/health", healthRouter);
  app.use("/v1/pricing", pricingRouter);

  // x402 facilitator: use public x402.org for testnet (no CDP keys needed),
  // or authenticated CDP facilitator for mainnet when keys are provided.
  const hasCdpKeys = !!(config.CDP_API_KEY_ID && config.CDP_API_KEY_SECRET);
  const facilitatorClient = hasCdpKeys
    ? new HTTPFacilitatorClient(
        createFacilitatorConfig(config.CDP_API_KEY_ID, config.CDP_API_KEY_SECRET)
      )
    : new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });

  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    "eip155:*",
    new ExactEvmScheme()
  );

  // Build route config for each (assetType, channel, duration) combo from pricing.json
  const routes = getAllRouteConfigs();
  const routeConfig: Record<string, any> = {};
  for (const r of routes) {
    routeConfig[`POST ${r.routePath}`] = {
      accepts: [
        {
          scheme: "exact",
          price: r.price,
          network: config.X402_NETWORK,
          payTo: config.PAYMENT_RECIPIENT_ADDRESS,
        },
      ],
      description: `Purchase ${r.duration} ${r.assetType} access at ${r.channel} rate`,
      mimeType: "application/json",
    };
  }

  app.use(paymentMiddleware(routeConfig, resourceServer));

  for (const r of routes) {
    app.post(r.routePath, purchaseHandler(r.assetType, r.channel, r.duration));
  }

  // Global error handler
  app.use(
    (err: Error, req: Request, res: Response, _next: NextFunction): void => {
      if (err instanceof z.ZodError) {
        res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message: err.errors
              .map((e) => `${e.path.join(".")}: ${e.message}`)
              .join(", "),
          },
        });
        return;
      }

      logger.error({ err, path: req.path }, "Unhandled error");
      res.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
        },
      });
    }
  );

  return app;
}
