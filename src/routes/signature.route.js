const { Router } = require("express");
const { verifySignatureController } = require("../controllers/signature.controller");
const { managerAuthenticateMiddleware } = require("../middlewares/authMiddleware");

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Signature
 *   description: Customer signature verification
 */

/**
 * @swagger
 * /signature/verify:
 *   post:
 *     summary: Verify a customer's captured signature against their reference signature
 *     tags: [Signature]
 *     responses:
 *       200: { description: Verification result }
 */
// Endpoint for signature verification
router.post("/verify", managerAuthenticateMiddleware, verifySignatureController);

module.exports = router;
