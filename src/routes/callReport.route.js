const express = require("express");
const router = express.Router();
const callReportController = require("../controllers/callReport.controller");
const { managerAuthenticateMiddleware } = require("../middlewares/authMiddleware");

router.post("/", managerAuthenticateMiddleware, callReportController.submitReport);
router.get("/service-types", managerAuthenticateMiddleware, callReportController.getServiceTypes);
router.get("/", managerAuthenticateMiddleware, callReportController.getReports);

module.exports = router;
