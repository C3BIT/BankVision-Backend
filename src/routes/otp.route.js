const { Router } = require('express');
const { 
  sendOtpController, 
  sendPhoneOtpController, 
  verifyPhoneOtpController, 
  verifyEmailController,
  sendExternalPhoneOtpController,
  verifyExternalPhoneOtpController,
} = require('../controllers/otp.controller');

const router = Router();

router.post('/send', sendOtpController);
router.post('/send-phone', sendPhoneOtpController);
router.post('/verify-phone', verifyPhoneOtpController);
router.post('/verify-email', verifyEmailController);
router.post('/send-external-phone', sendExternalPhoneOtpController);
router.post('/verify-external-phone', verifyExternalPhoneOtpController);

module.exports = router;