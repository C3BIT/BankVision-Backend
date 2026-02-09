const express = require("express");
const router = express.Router();
const nidController = require("../controllers/nid.controller");
const { managerAuthenticateMiddleware } = require("../middlewares/authMiddleware");

// NID Lookup
router.get("/lookup/:nidNumber", managerAuthenticateMiddleware, nidController.lookupNID);

// Verification flow
router.post("/verify/initiate", managerAuthenticateMiddleware, nidController.initiateVerification);
router.post("/verify/face", managerAuthenticateMiddleware, nidController.submitFaceMatch);
router.post("/verify/complete", managerAuthenticateMiddleware, nidController.completeVerification);
router.get("/verify/status/:verificationId", managerAuthenticateMiddleware, nidController.getVerificationStatus);

module.exports = router;
