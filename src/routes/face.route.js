const { Router } = require("express");
const { compareFacesController, compareFacesByAWSController, faceServiceHealthController, verifyIdentityController } = require("../controllers/face.controller");
const { managerAuthenticateMiddleware } = require("../middlewares/authMiddleware");

const router = Router();

// Face comparison / identity verification is a manager-operated control used
// during a live KYC call — the manager panel is the only legitimate caller
// (mirrors nid.route / signature.route). These routes were previously fully
// unauthenticated, exposing (a) a CBS identity match/no-match oracle over
// arbitrary account numbers and (b) SSRF via the server-side image fetch.
// Every route below now requires a valid manager session.

/**
 * @swagger
 * tags:
 *   name: Face
 *   description: Face comparison and identity verification (OpenCV/AWS Rekognition/MXFace)
 */

/**
 * @swagger
 * /face/compare:
 *   post:
 *     summary: Compare two face images using the configured provider (FACE_PROVIDER)
 *     tags: [Face]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [imagePath1, imagePath2]
 *             properties:
 *               imagePath1: { type: string, format: uri }
 *               imagePath2: { type: string, format: uri }
 *     responses:
 *       200: { description: "{ matched, similarity, confidence }" }
 */
router.post("/compare", managerAuthenticateMiddleware, compareFacesController);
/**
 * @swagger
 * /face/compare-aws:
 *   post:
 *     summary: Compare two face images, forcing AWS Rekognition
 *     tags: [Face]
 *     responses:
 *       200: { description: "{ matched, similarity, confidence }" }
 */
router.post("/compare-aws", managerAuthenticateMiddleware, compareFacesByAWSController);
/**
 * @swagger
 * /face/verify-identity:
 *   post:
 *     summary: Verify a customer's identity against their stored profile image
 *     tags: [Face]
 *     responses:
 *       200: { description: Verification result }
 */
router.post("/verify-identity", managerAuthenticateMiddleware, verifyIdentityController);
/**
 * @swagger
 * /face/health:
 *   get:
 *     summary: Check face verification service health
 *     tags: [Face]
 *     security: []
 *     responses:
 *       200: { description: "{ provider, opencv: { healthy, models_ready } }" }
 */
router.get("/health", faceServiceHealthController);
module.exports = router;
