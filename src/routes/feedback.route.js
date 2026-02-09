const express = require('express');
const router = express.Router();
const feedbackController = require('../controllers/feedback.controller');
const { managerAuthenticateMiddleware } = require('../middlewares/authMiddleware');

// Public route - customers can submit feedback without auth
router.post('/', feedbackController.submitFeedback);

// Protected routes - manager/admin only
router.get('/statistics', managerAuthenticateMiddleware, feedbackController.getFeedbackStatistics);
router.get('/', managerAuthenticateMiddleware, feedbackController.getFeedbackList);

module.exports = router;
