import cron from "node-cron";
import app from "./app";
import { logger } from "./lib/logger";
import { startGateway, stopGateway } from "./lib/openclaw-gateway";
import { generateDailyReport } from "./lib/daily-report";

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

  // Daily report cron: 06:00 Asia/Ho_Chi_Minh — yesterday's activity is now
  // fully settled, so this captures completed work from the previous day.
  // NOTE: requires the api-server process to be alive at 06:00 VN. On Replit
  // autoscale that means the server must be kept warm by some external pinger.
  const dailyReportTask = cron.schedule(
    "0 6 * * *",
    () => {
      logger.info("Cron: generating daily report");
      generateDailyReport()
        .then((r) => logger.info(r, "Cron: daily report done"))
        .catch((err) => logger.error({ err }, "Cron: daily report failed"));
    },
    { timezone: "Asia/Ho_Chi_Minh" },
  );
  logger.info(
    { schedule: "0 6 * * * (Asia/Ho_Chi_Minh)" },
    "Daily report cron registered",
  );
  // Touch task so it isn't tree-shaken if unused elsewhere
  void dailyReportTask;
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
