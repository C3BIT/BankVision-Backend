const { Router } = require("express");
const { verifySignatureController } = require("../controllers/signature.controller");
const { managerAuthenticateMiddleware } = require("../middlewares/authMiddleware");

const router = Router();

// Endpoint for signature verification
router.post("/verify", managerAuthenticateMiddleware, verifySignatureController);

module.exports = router;
