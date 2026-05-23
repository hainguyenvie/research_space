import { Router, type IRouter } from "express";
import healthRouter from "./health";
import openclawRouter from "./openclaw";
import reportsRouter from "./reports";

const router: IRouter = Router();

router.use(healthRouter);
router.use(openclawRouter);
router.use(reportsRouter);

export default router;
