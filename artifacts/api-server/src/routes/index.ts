import { Router, type IRouter } from "express";
import healthRouter from "./health";
import openclawRouter from "./openclaw";

const router: IRouter = Router();

router.use(healthRouter);
router.use(openclawRouter);

export default router;
