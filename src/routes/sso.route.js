const { Router } = require('express');
const { authenticateMtbNeo } = require('../controllers/sso.controller');
const { mtbNeoSsoRateLimiter } = require('../middlewares/rateLimiter');

const router = Router();

/**
 * @swagger
 * tags:
 *   name: SSO
 *   description: External-system single sign-on handoffs
 */

/**
 * @swagger
 * /sso/mtb-neo/authenticate:
 *   post:
 *     summary: Exchange an RSA-encrypted MTB Neo handshake payload for a customer session
 *     tags: [SSO]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [auth_key, session_id, cust_mob, cust_name]
 *             properties:
 *               auth_key: { type: string, description: "RSA-encrypted, base64" }
 *               session_id: { type: string, description: "RSA-encrypted, base64" }
 *               cust_mob: { type: string, description: "RSA-encrypted, base64" }
 *               cust_name: { type: string, description: "RSA-encrypted, base64" }
 *               cust_email: { type: string, description: "RSA-encrypted, base64 (optional)" }
 *     responses:
 *       200: { description: Authenticated, customer_auth_token cookie set }
 *       400: { description: Missing/malformed or undecryptable payload }
 *       401: { description: Invalid handshake key, replayed session, or unrecognized customer }
 *       429: { description: Rate limited }
 */
router.post('/mtb-neo/authenticate', mtbNeoSsoRateLimiter, authenticateMtbNeo);

module.exports = router;
