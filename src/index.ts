import * as http from "node:http";
import { createApp } from "./server.js";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { initSymbols } from "./symbols.js";

const logger = createLogger("main");

async function main() {
  await initSymbols();

  const app = createApp();
  const server = http.createServer(app);

  server.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "Gateway started");
  });

  // Graceful shutdown
  function shutdown() {
    logger.info("Shutting down...");
    server.close(() => {
      logger.info("Server closed");
      process.exit(0);
    });
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start");
  process.exit(1);
});
