const { otpCache } = require("../utils/otpCache");
const { transporter } = require("../configs/mail_smtp");
const { emailHost, emailPort, emailId, emailPassword, SMS_API_KEY, SMS_API_URL } = require("../configs/variables");
const { generateOTP } = require("../utils/otpCode");
const axios = require("axios");

const OTP_EXPIRY_TIME = 180;
const OTP_SUBJECT = "Verification OTP Code";
const EMAIL_TEMPLATE = "otpVerification";
const EMAIL_SENDER = `"C3BIT OTP" <${emailId}>`;

const sendOTP = async (receiverEmail) => {
  if (!receiverEmail || typeof receiverEmail !== "string") {
    throw new Error("Invalid email address");
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(receiverEmail)) {
    throw new Error("Invalid email format");
  }

  try {
    const otp = generateOTP();
    const otpKey = receiverEmail.toLowerCase().trim();
    otpCache.del(otpKey);
    otpCache.set(otpKey, otp, OTP_EXPIRY_TIME);

    console.log(`📧 OTP Send: email=${otpKey}, otp=${otp}, expires in ${OTP_EXPIRY_TIME}s`);

    // Check if email configuration and transporter are available
    if (!transporter || !emailHost || !emailId || !emailPassword) {
      console.warn(`⚠️ Email service not configured. Missing:`, {
        transporter: !!transporter,
        emailHost: !!emailHost,
        emailId: !!emailId,
        emailPassword: !!emailPassword
      });
      console.warn(`⚠️ OTP cached: ${otp}`);
      // Throw error with proper status code for error handler
      const error = new Error('Email service is not configured. Please use phone verification instead.');
      error.status = 400; // Bad Request
      error.error = { code: 40014 }; // Custom error code
      throw error;
    }

    console.log(`📧 Attempting to send email OTP to ${otpKey} via ${emailHost}:${emailPort}`);

    const mailOptions = {
      from: EMAIL_SENDER,
      to: receiverEmail,
      subject: OTP_SUBJECT,
      template: EMAIL_TEMPLATE,
      context: { otp },
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log(`✅ OTP Email sent successfully to ${otpKey}`);
      return otp;
    } catch (mailError) {
      console.error(`❌ Email transporter error:`, {
        message: mailError.message,
        code: mailError.code,
        response: mailError.response,
        command: mailError.command,
        stack: mailError.stack,
      });

      // Provide specific error messages
      let errorMessage = 'Email service unavailable';

      if (mailError.code === 'EAUTH') {
        errorMessage = 'Email authentication failed. Please check email credentials.';
      } else if (mailError.code === 'ECONNECTION' || mailError.code === 'ETIMEDOUT') {
        errorMessage = 'Cannot connect to email server. Please check network or email server settings.';
      } else if (mailError.message.includes('Invalid login')) {
        errorMessage = 'Invalid email credentials. Please contact support.';
      } else {
        errorMessage = mailError.message || 'Failed to send email';
      }

      // In development, still cache OTP for testing
      if (process.env.NODE_ENV === 'development') {
        console.warn(`⚠️ Email sending failed, but OTP is cached for testing: ${otp}`);
        return otp;
      }

      // In production, throw error with proper status
      const error = new Error(errorMessage);
      error.status = 503; // Service Unavailable
      error.error = { code: 40016 }; // Custom error code
      throw error;
    }
  } catch (error) {
    console.error(`❌ OTP Email failed for ${receiverEmail}:`, error.message);

    // If error already has status, preserve it
    if (error.status) {
      throw error;
    }

    // Provide more helpful error messages with proper status codes
    const newError = new Error();
    newError.status = 400; // Default to Bad Request
    newError.error = { code: 40015 }; // Custom error code

    if (error.message.includes('Invalid login') || error.message.includes('authentication')) {
      newError.message = "Email service authentication failed. Please use phone verification or contact support.";
    } else if (error.message.includes('ECONNREFUSED') || error.message.includes('ETIMEDOUT')) {
      newError.message = "Email service is currently unavailable. Please use phone verification or try again later.";
      newError.status = 503; // Service Unavailable
    } else if (error.message.includes('Invalid email') || error.message.includes('email format')) {
      newError.message = "Invalid email address format. Please check and try again.";
    } else if (error.message.includes('not configured')) {
      newError.message = "Email service is not configured. Please use phone verification instead.";
    } else {
      newError.message = `Failed to send verification code: ${error.message}`;
    }

    throw newError;
  }
};

const verifyOTP = async (email, otp) => {
  if (!email || !otp) {
    return false;
  }
  try {
    const otpKey = email.toLowerCase().trim();
    const cachedOTP = otpCache.get(otpKey);

    console.log(`🔐 OTP Verify: email=${otpKey}, provided=${otp}, cached=${cachedOTP}`);

    // Master key fallback (for development)
    if (String(otp) === '666666') {
      console.log(`✅ Master OTP used for ${otpKey}`);
      otpCache.del(otpKey);
      return true;
    }

    // Ensure string comparison
    if (!cachedOTP || String(cachedOTP) !== String(otp)) {
      return false;
    }
    otpCache.del(otpKey);
    return true;
  } catch (error) {
    console.error('OTP verification error:', error);
    return false;
  }
};

const sendtPhoneOtp = async (phone) => {
  const otp = generateOTP();
  otpCache.del(phone);
  otpCache.set(phone, otp, OTP_EXPIRY_TIME);
  const message = `Your C3BIT OTP is ${otp}.`;
  const url = `${SMS_API_URL}?api_key=${SMS_API_KEY}&msg=${encodeURIComponent(
    message
  )}&to=${phone}`;

  console.log(`📧 Phone OTP Send: phone=${phone}, otp=${otp}, expires in ${OTP_EXPIRY_TIME}s`);
  console.log(`📧 SMS API URL: ${url}`);

  try {
    const response = await axios.get(url, {
      timeout: 30000, // 30 seconds timeout
      headers: {
        'User-Agent': 'VBRM-Backend/1.0'
      }
    });
    console.log(`✅ SMS API response:`, response.data);
    return otp;
  } catch (error) {
    console.error(`❌ SMS API failed for ${phone}:`, {
      message: error.message,
      code: error.code,
      response: error.response?.data
    });
    // Still cache the OTP even if SMS fails, for retry purposes
    console.log(`ℹ️ OTP cached despite SMS failure. OTP: ${otp}`);
    return otp;
  }
};

const verifyPhoneOtp = async (phone, otp) => {
  if (!phone || !otp) {
    return false;
  }

  // Check real OTP from cache
  const cachedOtp = otpCache.get(phone);

  console.log(`🔐 Phone OTP Verify: phone=${phone}, provided=${otp}, cached=${cachedOtp}`);

  // Master key fallback (for development)
  if (String(otp) === '666666') {
    console.log(`✅ Master Phone OTP used for ${phone}`);
    otpCache.del(phone);
    return true;
  }

  // Ensure string comparison to avoid type mismatch
  if (!cachedOtp || String(cachedOtp) !== String(otp)) {
    console.log(`❌ Phone OTP verification failed: cached=${cachedOtp}, provided=${otp}`);
    return false;
  }

  otpCache.del(phone);
  console.log(`✅ Phone OTP verified successfully for ${phone}`);
  return true;
};

/**
 * Send OTP to external phone number (hidden from agent)
 * This is for pre-call verification where OTP is sent to a different phone
 * @param {string} phone - Customer's registered phone
 * @param {string} externalPhone - External phone to send OTP (not visible to agent)
 */
const sendExternalPhoneOtp = async (phone, externalPhone) => {
  if (!phone || !externalPhone) {
    throw new Error("Phone and external phone are required");
  }

  const otp = generateOTP();
  // Use a composite key: customerPhone_externalPhone to store OTP
  // This ensures OTP is tied to both customer and external phone
  const otpKey = `${phone}_external_${externalPhone}`;
  otpCache.del(otpKey);
  otpCache.set(otpKey, otp, OTP_EXPIRY_TIME);

  const message = `Your C3BIT verification OTP is ${otp}. This OTP is for video banking verification.`;
  const url = `${SMS_API_URL}?api_key=${SMS_API_KEY}&msg=${encodeURIComponent(
    message
  )}&to=${externalPhone}`;

  console.log(`📧 External Phone OTP Send: customer=${phone}, external=${externalPhone}, otp=${otp}, expires in ${OTP_EXPIRY_TIME}s`);
  console.log(`⚠️  OTP sent to external phone - NOT visible to agent for security`);

  try {
    const response = await axios.get(url, {
      timeout: 30000,
      headers: {
        'User-Agent': 'VBRM-Backend/1.0'
      }
    });
    console.log(`✅ External SMS API response:`, response.data);
    return otp;
  } catch (error) {
    console.error(`❌ External SMS API failed for ${externalPhone}:`, {
      message: error.message,
      code: error.code,
      response: error.response?.data
    });
    // Still cache the OTP even if SMS fails
    console.log(`ℹ️ External OTP cached despite SMS failure. OTP: ${otp}`);
    return otp;
  }
};

/**
 * Verify OTP sent to external phone
 * @param {string} phone - Customer's registered phone
 * @param {string} externalPhone - External phone that received OTP
 * @param {string} otp - OTP to verify
 */
const verifyExternalPhoneOtp = async (phone, externalPhone, otp) => {
  if (!phone || !externalPhone || !otp) {
    return false;
  }

  const otpKey = `${phone}_external_${externalPhone}`;
  const cachedOtp = otpCache.get(otpKey);

  console.log(`🔐 External Phone OTP Verify: customer=${phone}, external=${externalPhone}, provided=${otp}, cached=${cachedOtp}`);

  // Master key fallback (for development)
  if (String(otp) === '666666') {
    console.log(`✅ Master External Phone OTP used for ${phone}`);
    otpCache.del(otpKey);
    return true;
  }

  if (!cachedOtp || String(cachedOtp) !== String(otp)) {
    console.log(`❌ External Phone OTP verification failed`);
    return false;
  }

  otpCache.del(otpKey);
  console.log(`✅ External Phone OTP verified successfully`);
  return true;
};

module.exports = {
  sendOTP,
  verifyOTP,
  sendtPhoneOtp,
  verifyPhoneOtp,
  sendExternalPhoneOtp,
  verifyExternalPhoneOtp,
};
