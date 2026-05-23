import { Router, type IRouter } from "express";
import healthRouter from "./health";
import profilesRouter from "./profiles";
import conversationsRouter from "./conversations";
import importRouter from "./import";
import libraryRouter from "./library";

const router: IRouter = Router();

router.use(healthRouter);
router.use(profilesRouter);
router.use(conversationsRouter);
router.use(importRouter);
router.use(libraryRouter);

export default router;
