const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');

// LiveKit Webhook endpoint
// We use express.raw({ type: 'application/webhook+json' }) if signature verification requires it,
// but for standard body parsing, ensure the app uses express.json()
router.post('/livekit', webhookController.handleLiveKitWebhook);

module.exports = router;
