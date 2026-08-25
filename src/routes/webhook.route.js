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
// LiveKit Webhook endpoint. LiveKit POSTs as `application/webhook+json` — the
// global express.json() in index.js is configured to also parse that type
// (and to stash req.rawBody) so the signature check in handleLiveKitWebhook
// sees the real body.
router.post('/livekit', webhookController.handleLiveKitWebhook);

module.exports = router;
