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

const router = Router();

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
router.post('/send', otpRateLimiter, sendOtpController);

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
router.post('/send-phone', otpRateLimiter, sendPhoneOtpController);

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
router.post('/verify-external-phone', verifyExternalPhoneOtpController);

module.exports = router;