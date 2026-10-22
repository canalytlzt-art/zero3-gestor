import { Router, type IRouter } from "express";
import healthRouter from "./health";
import salesRouter from "./sales";
import occupancyRouter from "./occupancy";

const router: IRouter = Router();

router.use(healthRouter);
router.use(salesRouter);
router.use(occupancyRouter);

export default router;
