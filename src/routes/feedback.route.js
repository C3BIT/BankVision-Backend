const express = require('express');
const router = express.Router();
const feedbackController = require('../controllers/feedback.controller');
const { managerAuthenticateMiddleware } = require('../middlewares/authMiddleware');

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
router.get('/statistics', managerAuthenticateMiddleware, feedbackController.getFeedbackStatistics);
router.get('/', managerAuthenticateMiddleware, feedbackController.getFeedbackList);

module.exports = router;
