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

const router = Router();

router.post('/send', requireCaptcha, otpRateLimiter, sendOtpController);
router.post('/send-phone', requireCaptcha, otpRateLimiter, sendPhoneOtpController);
router.post('/verify-phone', verifyPhoneOtpController);
router.post('/verify-email', verifyEmailController);
router.post('/send-external-phone', otpRateLimiter, sendExternalPhoneOtpController);
router.post('/verify-external-phone', verifyExternalPhoneOtpController);

module.exports = router;