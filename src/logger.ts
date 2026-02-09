import fs from "node:fs";
import path from "node:path";
import pino from "pino";

const LOG_DIR = path.resolve(import.meta.dirname, "..", "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

const logFile = path.join(LOG_DIR, "gateway.log");
const isDev = process.env.NODE_ENV !== "production";

const fileStream = pino.destination({ dest: logFile, append: true, sync: false });

export function createLogger(name: string) {
  return pino(
    { name },
    pino.multistream([
      // Always write JSON to file
      { stream: fileStream },
      // Stdout: pretty in dev, JSON in prod
      isDev
        ? { stream: pino.transport({ target: "pino-pretty" }) }
        : { stream: pino.destination(1) },
    ])
  );
}
