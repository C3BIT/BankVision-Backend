const { Router } = require('express');
const { 
  sendOtpController, 
  sendPhoneOtpController, 
  verifyPhoneOtpController, 
  verifyEmailController,
  sendExternalPhoneOtpController,
  verifyExternalPhoneOtpController,
} = require('../controllers/otp.controller');
const { otpRateLimiter } = require('../middlewares/rateLimiter');
const { requireCaptcha } = require('../middlewares/captchaMiddleware');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../configs/variables');
const { getTokenFromRequest } = require('../utils/cookieHelper');

const router = Router();

// True when the request already carries a valid platform session (customer /
// manager / admin). The customer's INITIAL call-start OTP send is the only
// unauthenticated send — every other send (in-call resend, contact-change,
// staff-initiated) happens inside an established session.
const hasValidSession = (req) => {
  const raw =
    getTokenFromRequest(req, 'customer_auth_token') ||
    getTokenFromRequest(req, 'manager_auth_token') ||
    getTokenFromRequest(req, 'admin_auth_token');
  if (!raw) return false;
  try {
    jwt.verify(raw, jwtSecret, { algorithms: ['HS256'] });
    return true;
  } catch {
    return false;
  }
};

// Enforce CAPTCHA ONLY on the public, unauthenticated OTP send (the customer's
// initial call-start). Authenticated flows skip it so we don't add friction to
// in-call resends or staff-initiated sends. This is the bot-defense entry gate
// that was implemented (captchaMiddleware) but never wired to any route.
const captchaForInitialStart = (req, res, next) =>
  hasValidSession(req) ? next() : requireCaptcha(req, res, next);

/**
 * @swagger
 * tags:
 *   name: OTP
 *   description: Email/phone OTP issuance and verification
 */

/**
 * @swagger
 * /otp/send:
 *   post:
 *     summary: Send an email OTP
 *     tags: [OTP]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       200: { description: OTP sent, content: { application/json: { schema: { $ref: '#/components/schemas/Success' } } } }
 *       429: { description: Rate limited }
 */
router.post('/send', otpRateLimiter, captchaForInitialStart, sendOtpController);

/**
 * @swagger
 * /otp/send-phone:
 *   post:
 *     summary: Send an SMS OTP to a customer phone number
 *     tags: [OTP]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone]
 *             properties:
 *               phone: { type: string, example: "01712345678" }
 *     responses:
 *       200: { description: OTP sent }
 *       429: { description: Rate limited }
 */
router.post('/send-phone', otpRateLimiter, captchaForInitialStart, sendPhoneOtpController);

/**
 * @swagger
 * /otp/verify-phone:
 *   post:
 *     summary: Verify a phone OTP (accepts hardcoded 666666 in non-production QA mode)
 *     tags: [OTP]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone, otp]
 *             properties:
 *               phone: { type: string }
 *               otp: { type: string, example: "666666" }
 *     responses:
 *       200: { description: Verified }
 *       400: { description: Invalid or expired OTP }
 */
router.post('/verify-phone', verifyPhoneOtpController);

/**
 * @swagger
 * /otp/verify-email:
 *   post:
 *     summary: Verify an email OTP
 *     tags: [OTP]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, otp]
 *             properties:
 *               email: { type: string, format: email }
 *               otp: { type: string }
 *     responses:
 *       200: { description: Verified }
 *       400: { description: Invalid or expired OTP }
 */
router.post('/verify-email', verifyEmailController);

/**
 * @swagger
 * /otp/send-external-phone:
 *   post:
 *     summary: Send an SMS OTP for an external (non-active-call) verification flow
 *     tags: [OTP]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone]
 *             properties:
 *               phone: { type: string }
 *     responses:
 *       200: { description: OTP sent }
 */
router.post('/send-external-phone', otpRateLimiter, sendExternalPhoneOtpController);

/**
 * @swagger
 * /otp/verify-external-phone:
 *   post:
 *     summary: Verify an external SMS OTP
 *     tags: [OTP]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone, otp]
 *             properties:
 *               phone: { type: string }
 *               otp: { type: string }
 *     responses:
 *       200: { description: Verified }
 */
router.post('/verify-external-phone', otpRateLimiter, verifyExternalPhoneOtpController);

module.exports = router;