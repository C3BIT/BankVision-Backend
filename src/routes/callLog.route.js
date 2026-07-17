const express = require("express");
const router = express.Router();
const callLogController = require("../controllers/callLog.controller");
const { managerAuthenticateMiddleware } = require("../middlewares/authMiddleware");

/**
 * @swagger
 * tags:
 *   name: CallLogs
 *   description: Call history, statistics, and per-customer/manager call logs
 */

/**
 * @swagger
 * /call-logs/statistics:
 *   get:
 *     summary: Get overall call statistics
 *     tags: [CallLogs]
 *     responses:
 *       200: { description: Call statistics }
 */
router.get("/statistics", managerAuthenticateMiddleware, callLogController.getCallStatistics);

/**
 * @swagger
 * /call-logs/customer/{customerPhone}:
 *   get:
 *     summary: Get call logs for a specific customer
 *     tags: [CallLogs]
 *     parameters:
 *       - in: path
 *         name: customerPhone
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Customer call logs }
 */
router.get("/customer/:customerPhone", managerAuthenticateMiddleware, callLogController.getCustomerCallLogs);

/**
 * @swagger
 * /call-logs/manager/{managerEmail}:
 *   get:
 *     summary: Get call logs for a specific manager
 *     tags: [CallLogs]
 *     parameters:
 *       - in: path
 *         name: managerEmail
 *         required: true
 *         schema: { type: string, format: email }
 *     responses:
 *       200: { description: Manager call logs }
 */
router.get("/manager/:managerEmail", managerAuthenticateMiddleware, callLogController.getManagerCallLogs);

/**
 * @swagger
 * /call-logs/manager/{managerEmail}/statistics:
 *   get:
 *     summary: Get call statistics for a specific manager
 *     tags: [CallLogs]
 *     parameters:
 *       - in: path
 *         name: managerEmail
 *         required: true
 *         schema: { type: string, format: email }
 *     responses:
 *       200: { description: Manager statistics }
 */
router.get("/manager/:managerEmail/statistics", managerAuthenticateMiddleware, callLogController.getManagerStatistics);

/**
 * @swagger
 * /call-logs:
 *   get:
 *     summary: List all call logs (filterable, paginated)
 *     tags: [CallLogs]
 *     responses:
 *       200: { description: Call logs }
 */
router.get("/", managerAuthenticateMiddleware, callLogController.getCallLogs);

/**
 * @swagger
 * /call-logs/{id}:
 *   get:
 *     summary: Get a single call log by ID
 *     tags: [CallLogs]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Call log }
 *       404: { description: Not found }
 */
router.get("/:id", managerAuthenticateMiddleware, callLogController.getCallLogById);

module.exports = router;
