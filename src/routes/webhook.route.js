const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');

/**
 * @swagger
 * tags:
 *   name: Webhook
 *   description: External service webhook receivers
 */

/**
 * @swagger
 * /webhook/livekit:
 *   post:
 *     summary: Receive LiveKit egress/room webhook events
 *     tags: [Webhook]
 *     security: []
 *     responses:
 *       200: { description: Event processed }
 */
// LiveKit Webhook endpoint
// We use express.raw({ type: 'application/webhook+json' }) if signature verification requires it,
// but for standard body parsing, ensure the app uses express.json()
router.post('/livekit', webhookController.handleLiveKitWebhook);

module.exports = router;
