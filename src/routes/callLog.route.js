const express = require("express");
const router = express.Router();
const callLogController = require("../controllers/callLog.controller");
const { managerAuthenticateMiddleware } = require("../middlewares/authMiddleware");

// Get call statistics (must be before /:id)
router.get("/statistics", managerAuthenticateMiddleware, callLogController.getCallStatistics);

// Get call logs for a specific customer (must be before /:id)
router.get("/customer/:customerPhone", managerAuthenticateMiddleware, callLogController.getCustomerCallLogs);

// Get call logs for a specific manager (must be before /:id)
router.get("/manager/:managerEmail", managerAuthenticateMiddleware, callLogController.getManagerCallLogs);

// Get statistics for a specific manager (must be before /:id)
router.get("/manager/:managerEmail/statistics", managerAuthenticateMiddleware, callLogController.getManagerStatistics);

// Get all call logs (with filters and pagination)
router.get("/", managerAuthenticateMiddleware, callLogController.getCallLogs);

// Get single call log by ID (must be last as it catches all)
router.get("/:id", managerAuthenticateMiddleware, callLogController.getCallLogById);

module.exports = router;
