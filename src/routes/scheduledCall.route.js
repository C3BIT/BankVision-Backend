const express = require('express');
const router = express.Router();
const scheduledCallController = require('../controllers/scheduledCall.controller');
const { managerAuthenticateMiddleware } = require('../middlewares/authMiddleware');

/**
 * @swagger
 * tags:
 *   name: ScheduledCalls
 *   description: Manager-scheduled customer callbacks
 */

router.use(managerAuthenticateMiddleware);

router.post('/', scheduledCallController.createScheduledCall);
router.get('/', scheduledCallController.listScheduledCalls);
router.patch('/:id', scheduledCallController.updateScheduledCall);
router.patch('/:id/cancel', scheduledCallController.cancelScheduledCall);
router.patch('/:id/complete', scheduledCallController.completeScheduledCall);

module.exports = router;
