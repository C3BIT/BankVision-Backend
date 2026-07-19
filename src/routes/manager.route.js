const { Router } = require("express");
const {
  registerManagerController,
  loginManagerController,
  getCurrentManagerController,
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

const router = new Router();

/**
 * @swagger
 * tags:
 *   name: Manager
 *   description: Manager account registration, auth, and session management
 */

/**
 * @swagger
 * /manager/registration:
 *   post:
 *     summary: Register a new manager account
 *     tags: [Manager]
 *     security: []
 *     responses:
 *       201: { description: Manager created }
 */
router.post("/registration", authRateLimiter, registerManagerController);

/**
 * @swagger
 * /manager/login:
 *   post:
 *     summary: Manager login (captcha + brute-force protected)
 *     tags: [Manager]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, format: password }
 *     responses:
 *       200: { description: Logged in, JWT returned }
 *       401: { description: Invalid credentials }
 *       423: { description: Account locked (brute-force protection) }
 */
router.post("/login", authRateLimiter, bruteForceProtection(), loginManagerController);

/**
 * @swagger
 * /manager/me:
 *   get:
 *     summary: Get the currently authenticated manager (resolved from auth cookie/token)
 *     tags: [Manager]
 *     responses:
 *       200: { description: Current manager profile }
 *       401: { description: Not authenticated }
 */
router.get("/me", managerAuthenticateMiddleware, getCurrentManagerController);

/**
 * @swagger
 * /manager/forgot-password:
 *   post:
 *     summary: Request a password reset email
 *     tags: [Manager]
 *     security: []
 *     responses:
 *       200: { description: Reset email sent if account exists }
 */
router.post("/forgot-password", passwordResetRateLimiter, forgotPasswordController);

/**
 * @swagger
 * /manager/reset-password:
 *   post:
 *     summary: Reset password using a reset token
 *     tags: [Manager]
 *     security: []
 *     responses:
 *       200: { description: Password reset }
 *       400: { description: Invalid or expired token }
 */
router.post("/reset-password", passwordResetRateLimiter, resetPasswordController);

/**
 * @swagger
 * /manager/logout:
 *   post:
 *     summary: Log out the current manager session
 *     tags: [Manager]
 *     responses:
 *       200: { description: Logged out }
 */
router.post("/logout", managerAuthenticateMiddleware, logoutManagerController);

module.exports = router;