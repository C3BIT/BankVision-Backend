const { Router } = require("express");
const { compareFacesController, compareFacesByAWSController, faceServiceHealthController, verifyIdentityController } = require("../controllers/face.controller");

const router = Router();

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
router.post("/compare", compareFacesController);
/**
 * @swagger
 * /face/compare-aws:
 *   post:
 *     summary: Compare two face images, forcing AWS Rekognition
 *     tags: [Face]
 *     responses:
 *       200: { description: "{ matched, similarity, confidence }" }
 */
router.post("/compare-aws", compareFacesByAWSController);
/**
 * @swagger
 * /face/verify-identity:
 *   post:
 *     summary: Verify a customer's identity against their stored profile image
 *     tags: [Face]
 *     responses:
 *       200: { description: Verification result }
 */
router.post("/verify-identity", verifyIdentityController);
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
