const express = require("express");
const router = express.Router();
const jsonwebtoken = require("jsonwebtoken");
const callReportController = require("../controllers/callReport.controller");
const { managerAuthenticateMiddleware } = require("../middlewares/authMiddleware");
const { jwtSecret } = require("../configs/variables");
const { getTokenFromRequest } = require("../utils/cookieHelper");

// Reports are submitted by managers but viewed by managers and admin-panel staff alike;
// mirrors the manager/admin/supervisor pattern in forms.route.js.
const viewerAuth = (req, res, next) => {
  // Manager and admin sessions use distinct cookie names (see cookieHelper.js) —
  // this route accepts either role, so both are checked as fallbacks.
  const token = getTokenFromRequest(req, 'manager_auth_token') || getTokenFromRequest(req, 'admin_auth_token');
  if (!token) {
    return res.status(401).json({ success: false, message: "Authentication required" });
  }
  try {
    const decoded = jsonwebtoken.verify(token, jwtSecret, { algorithms: ["HS256"] });
    const allowed = ["manager", "admin", "supervisor", "super_admin"];
    if (!allowed.includes(decoded.role)) {
      return res.status(403).json({ success: false, message: "Insufficient permissions" });
    }
    req.user = decoded;
    return next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
};

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
router.get("/service-types", viewerAuth, callReportController.getServiceTypes);
router.get("/dispositions", viewerAuth, callReportController.getDispositions);
router.get("/", viewerAuth, callReportController.getReports);

module.exports = router;
