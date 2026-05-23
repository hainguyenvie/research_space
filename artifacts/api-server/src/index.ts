import app from "./app";
import { logger } from "./lib/logger";
import { startGateway, stopGateway } from "./lib/openclaw-gateway";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Start OpenClaw gateway in background (non-blocking)
  startGateway().catch((err) => {
    logger.error({ err }, "Failed to start OpenClaw gateway");
  });
});

// Graceful shutdown
const shutdown = () => {
  logger.info("Shutting down…");
  stopGateway();
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
