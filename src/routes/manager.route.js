const { Router } = require("express");
const {
  registerManagerController,
  loginManagerController,
  forgotPasswordController,
  resetPasswordController,
  logoutManagerController
} = require("../controllers/manager.controller");
const { managerAuthenticateMiddleware } = require("../middlewares/authMiddleware");
const {
  authRateLimiter,
  passwordResetRateLimiter,
  bruteForceProtection
} = require("../middlewares/securityMiddleware");
const { requireCaptcha } = require("../middlewares/captchaMiddleware");

const router = new Router();

// Public routes (with security middleware)
router.post("/registration", authRateLimiter, registerManagerController);
router.post("/login", requireCaptcha, authRateLimiter, bruteForceProtection(), loginManagerController);
router.post("/forgot-password", requireCaptcha, passwordResetRateLimiter, forgotPasswordController);
router.post("/reset-password", passwordResetRateLimiter, resetPasswordController);

// Protected routes
router.post("/logout", managerAuthenticateMiddleware, logoutManagerController);

module.exports = router;