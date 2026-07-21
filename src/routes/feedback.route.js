const express = require('express');
const router = express.Router();
const feedbackController = require('../controllers/feedback.controller');
const { managerAuthenticateMiddleware } = require('../middlewares/authMiddleware');
const { adminAuthenticateMiddleware } = require('../middlewares/adminAuthMiddleware');
const { getTokenFromRequest } = require('../utils/cookieHelper');

// The Admin Panel's Feedback tab and the Manager Panel both read this route,
// but each carries a differently-named auth cookie (admin_auth_token vs
// manager_auth_token) — dispatch to whichever middleware matches the cookie
// actually present instead of hardcoding one, which previously 401'd every
// admin request here.
const managerOrAdminAuth = (req, res, next) => {
  if (getTokenFromRequest(req, 'admin_auth_token')) {
    return adminAuthenticateMiddleware(req, res, next);
  }
  return managerAuthenticateMiddleware(req, res, next);
};

/**
 * @swagger
 * tags:
 *   name: Feedback
 *   description: Post-call customer feedback submission and review
 */

/**
 * @swagger
 * /feedback:
 *   post:
 *     summary: Submit customer feedback (public, no auth)
 *     tags: [Feedback]
 *     security: []
 *     responses:
 *       201: { description: Feedback submitted }
 *   get:
 *     summary: List submitted feedback (manager/admin only)
 *     tags: [Feedback]
 *     responses:
 *       200: { description: Feedback list }
 */
// Public route - customers can submit feedback without auth
router.post('/', feedbackController.submitFeedback);

// Protected routes - manager/admin only
/**
 * @swagger
 * /feedback/statistics:
 *   get:
 *     summary: Get feedback statistics
 *     tags: [Feedback]
 *     responses:
 *       200: { description: Feedback statistics }
 */
router.get('/statistics', managerOrAdminAuth, feedbackController.getFeedbackStatistics);
router.get('/', managerOrAdminAuth, feedbackController.getFeedbackList);

module.exports = router;
