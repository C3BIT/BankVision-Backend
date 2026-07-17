const express = require("express");
const router = express.Router();
const callReportController = require("../controllers/callReport.controller");
const { managerAuthenticateMiddleware } = require("../middlewares/authMiddleware");

/**
 * @swagger
 * tags:
 *   name: CallReports
 *   description: Post-call service reports submitted by managers
 */

/**
 * @swagger
 * /call-reports:
 *   post:
 *     summary: Submit a call report
 *     tags: [CallReports]
 *     responses:
 *       201: { description: Report submitted }
 *   get:
 *     summary: List call reports
 *     tags: [CallReports]
 *     responses:
 *       200: { description: Call reports }
 */
router.post("/", managerAuthenticateMiddleware, callReportController.submitReport);
/**
 * @swagger
 * /call-reports/service-types:
 *   get:
 *     summary: List available service types for reports
 *     tags: [CallReports]
 *     responses:
 *       200: { description: Service types }
 */
router.get("/service-types", managerAuthenticateMiddleware, callReportController.getServiceTypes);
router.get("/", managerAuthenticateMiddleware, callReportController.getReports);

module.exports = router;
