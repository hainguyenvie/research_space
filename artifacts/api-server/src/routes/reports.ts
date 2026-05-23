import { Router, type IRouter, type Request, type Response } from "express";
import { generateDailyReport } from "../lib/daily-report";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /api/reports/daily
// Regenerates the daily / sprint report into the configured Google Doc.
// Idempotent — safe to call multiple times per day.
// Used by:
//   - The OpenClaw `daily-report` skill (model invokes via curl)
//   - The internal node-cron job at 06:00 VN time
//   - Manual trigger from anywhere
// ---------------------------------------------------------------------------
router.post("/reports/daily", async (_req: Request, res: Response) => {
  try {
    const result = await generateDailyReport();
    logger.info(result, "Daily report generated");
    res.json({ ok: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Daily report failed");
    res.status(500).json({ ok: false, error: message });
  }
});

export default router;
