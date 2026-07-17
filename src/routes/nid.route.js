const express = require("express");
const router = express.Router();
const nidController = require("../controllers/nid.controller");
const { managerAuthenticateMiddleware } = require("../middlewares/authMiddleware");

/**
 * @swagger
 * tags:
 *   name: NID
 *   description: National ID lookup and verification flow
 */

/**
 * @swagger
 * /nid/lookup/{nidNumber}:
 *   get:
 *     summary: Look up a national ID record
 *     tags: [NID]
 *     parameters:
 *       - in: path
 *         name: nidNumber
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: NID record }
 */
// NID Lookup
router.get("/lookup/:nidNumber", managerAuthenticateMiddleware, nidController.lookupNID);

// Verification flow
/**
 * @swagger
 * /nid/verify/initiate:
 *   post:
 *     summary: Initiate NID verification
 *     tags: [NID]
 *     responses:
 *       200: { description: Verification initiated }
 */
router.post("/verify/initiate", managerAuthenticateMiddleware, nidController.initiateVerification);
/**
 * @swagger
 * /nid/verify/face:
 *   post:
 *     summary: Submit a face match for NID verification
 *     tags: [NID]
 *     responses:
 *       200: { description: Face match result }
 */
router.post("/verify/face", managerAuthenticateMiddleware, nidController.submitFaceMatch);
/**
 * @swagger
 * /nid/verify/complete:
 *   post:
 *     summary: Complete NID verification
 *     tags: [NID]
 *     responses:
 *       200: { description: Verification completed }
 */
router.post("/verify/complete", managerAuthenticateMiddleware, nidController.completeVerification);
/**
 * @swagger
 * /nid/verify/status/{verificationId}:
 *   get:
 *     summary: Get NID verification status
 *     tags: [NID]
 *     parameters:
 *       - in: path
 *         name: verificationId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Verification status }
 */
router.get("/verify/status/:verificationId", managerAuthenticateMiddleware, nidController.getVerificationStatus);

module.exports = router;
