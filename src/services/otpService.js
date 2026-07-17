const { otpCache } = require("../utils/otpCache");
const {
  CBS_SMS_URL, CBS_SMS_USERNAME, CBS_SMS_PASSWORD, CBS_SMS_CHANNEL_ID, CBS_SMS_EVENT,
  CBS_EMAIL_URL, CBS_EMAIL_CHANNEL_ID, CBS_FROM_EMAIL, CBS_FROM_EMAIL_DISPLAY_NAME, CBS_EMAIL_EVENT,
  CBS_USERNAME, CBS_PASSWORD,
} = require("../configs/variables");
const { generateOTP } = require("../utils/otpCode");
const axios = require("axios");

const OTP_EXPIRY_TIME = 180;
const OTP_SUBJECT = "Verification OTP Code";
const MAX_OTP_ATTEMPTS = 3;
const LOCKOUT_TTL = 900; // 15 minutes

// Master OTP bypass: unconditionally enabled at the user's explicit request
// (re-approved after being told this reopens the pentest's Critical finding #1
// with no environment safeguard). Every use is logged loudly below so it is
// at least auditable. MUST be removed/re-gated before production/live-customer use.
const isMasterOtp = (otp) => String(otp) === '666666';

const attemptsKey = (key) => `${key}_attempts`;
const lockoutKey  = (key) => `${key}_locked`;

const checkLockout = (key) => {
  if (otpCache.get(lockoutKey(key))) {
    const err = new Error("Too many incorrect OTP attempts. Please request a new OTP after 15 minutes.");
    err.status = 429;
    err.error = { code: 40017 };
    throw err;
  }
};

const recordFailedAttempt = (key) => {
  const attempts = (otpCache.get(attemptsKey(key)) || 0) + 1;
  if (attempts >= MAX_OTP_ATTEMPTS) {
    otpCache.del(key);
    otpCache.del(attemptsKey(key));
    otpCache.set(lockoutKey(key), true, LOCKOUT_TTL);
    const err = new Error("Too many incorrect OTP attempts. Please request a new OTP after 15 minutes.");
    err.status = 429;
    err.error = { code: 40017 };
    throw err;
  }
  otpCache.set(attemptsKey(key), attempts, OTP_EXPIRY_TIME);
  return attempts;
};

const clearAttempts = (key) => {
  otpCache.del(attemptsKey(key));
  otpCache.del(lockoutKey(key));
};

const sendOTP = async (receiverEmail) => {
  if (!receiverEmail || typeof receiverEmail !== "string") {
    throw new Error("Invalid email address");
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(receiverEmail)) {
    throw new Error("Invalid email format");
  }

  const otp = generateOTP();
  const otpKey = receiverEmail.toLowerCase().trim();
  otpCache.del(otpKey);
  otpCache.set(otpKey, otp, OTP_EXPIRY_TIME);
  clearAttempts(otpKey);

  console.log(`📧 OTP Send: email=${otpKey}, otp=${otp}, expires in ${OTP_EXPIRY_TIME}s`);

  try {
    console.log(`📧 Routing email via CBS gateway: ${CBS_EMAIL_URL}`);
    await axios.post(
      CBS_EMAIL_URL,
      {
        fromEmailDisplayName: CBS_FROM_EMAIL_DISPLAY_NAME,
        refNo: `OTP-${Date.now()}`,
        emailEvent: CBS_EMAIL_EVENT || "OTP",
        emailContent: `Your BankVision OTP is ${otp}. Valid for 3 minutes. Do not share.`,
        emailSubject: OTP_SUBJECT,
        email: receiverEmail,
        customerName: "Customer",
        channelId: CBS_EMAIL_CHANNEL_ID || "101",
        fromEmail: CBS_FROM_EMAIL,
      },
      {
        timeout: 8000,
        auth: { username: CBS_USERNAME, password: CBS_PASSWORD },
      }
    );
    console.log(`✅ CBS email OTP sent to ${otpKey}`);
    return otp;
  } catch (error) {
    console.error(`❌ CBS email OTP failed for ${receiverEmail}:`, error.message);
    const err = new Error("Failed to send OTP email via CBS gateway");
    err.status = 503;
    err.error = { code: 40016 };
    throw err;
  }
};

const verifyOTP = async (email, otp) => {
  if (!email || !otp) return false;
  const otpKey = email.toLowerCase().trim();
  checkLockout(otpKey);
  const cachedOTP = otpCache.get(otpKey);

  console.log(`🔐 OTP Verify: email=${otpKey}, provided=${otp}, cached=${cachedOTP}`);

  if (isMasterOtp(otp)) {
    console.warn(`🚨 MASTER OTP BYPASS USED: email=${otpKey}, time=${new Date().toISOString()}`);
    otpCache.del(otpKey);
    clearAttempts(otpKey);
    return true;
  }

  if (!cachedOTP || String(cachedOTP) !== String(otp)) {
    const attempts = recordFailedAttempt(otpKey);
    console.log(`❌ Email OTP failed (attempt ${attempts}/${MAX_OTP_ATTEMPTS})`);
    return false;
  }

  otpCache.del(otpKey);
  clearAttempts(otpKey);
  return true;
};

const sendtPhoneOtp = async (phone) => {
  const otp = generateOTP();
  otpCache.del(phone);
  otpCache.set(phone, otp, OTP_EXPIRY_TIME);
  clearAttempts(phone);
  const message = `Your BankVision OTP is ${otp}. Valid for 3 minutes. Do not share.`;

  console.log(`📱 Phone OTP Send: phone=${phone}, otp=${otp}, expires in ${OTP_EXPIRY_TIME}s`);

  try {
    console.log(`📱 Routing SMS via CBS gateway: ${CBS_SMS_URL}`);
    const response = await axios.post(
      CBS_SMS_URL,
      {
        channelId: CBS_SMS_CHANNEL_ID || "101",
        smsEvent: CBS_SMS_EVENT || "PIN",
        smsContent: message,
        mobileNo: String(phone).replace(/^(\+88|88)/, ""),
        refNo: `OTP-${Date.now()}`,
      },
      {
        auth: { username: CBS_SMS_USERNAME, password: CBS_SMS_PASSWORD },
        timeout: 8000,
      }
    );
    console.log(`✅ CBS SMS response:`, response.data);
  } catch (error) {
    console.error(`❌ CBS SMS failed for ${phone}:`, { message: error.message, code: error.code });
    console.log(`ℹ️ OTP cached despite SMS failure. OTP: ${otp}`);
  }
  return otp;
};

const verifyPhoneOtp = async (phone, otp) => {
  if (!phone || !otp) return false;

  checkLockout(phone);
  const cachedOtp = otpCache.get(phone);
  console.log(`🔐 Phone OTP Verify: phone=${phone}, provided=${otp}, cached=${cachedOtp}`);

  if (isMasterOtp(otp)) {
    console.warn(`🚨 MASTER OTP BYPASS USED: phone=${phone}, time=${new Date().toISOString()}`);
    otpCache.del(phone);
    clearAttempts(phone);
    return true;
  }

  if (!cachedOtp || String(cachedOtp) !== String(otp)) {
    const attempts = recordFailedAttempt(phone);
    console.log(`❌ Phone OTP failed (attempt ${attempts}/${MAX_OTP_ATTEMPTS}): cached=${cachedOtp}, provided=${otp}`);
    return false;
  }

  otpCache.del(phone);
  clearAttempts(phone);
  console.log(`✅ Phone OTP verified successfully for ${phone}`);
  return true;
};

const sendExternalPhoneOtp = async (phone, externalPhone) => {
  if (!phone || !externalPhone) {
    throw new Error("Phone and external phone are required");
  }

  const otp = generateOTP();
  const otpKey = `${phone}_external_${externalPhone}`;
  otpCache.del(otpKey);
  otpCache.set(otpKey, otp, OTP_EXPIRY_TIME);

  const message = `Your BankVision verification OTP is ${otp}. Valid for 3 minutes. Do not share.`;

  console.log(`📱 External Phone OTP Send: customer=${phone}, external=${externalPhone}, otp=${otp}`);
  console.log(`⚠️  OTP sent to external phone - NOT visible to agent for security`);

  try {
    const response = await axios.post(
      CBS_SMS_URL,
      {
        channelId: CBS_SMS_CHANNEL_ID || "101",
        smsEvent: CBS_SMS_EVENT || "PIN",
        smsContent: message,
        mobileNo: String(externalPhone).replace(/^(\+88|88)/, ""),
        refNo: `EXT-OTP-${Date.now()}`,
      },
      { auth: { username: CBS_SMS_USERNAME, password: CBS_SMS_PASSWORD }, timeout: 8000 }
    );
    console.log(`✅ CBS External SMS response:`, response.data);
  } catch (error) {
    console.error(`❌ External CBS SMS failed for ${externalPhone}:`, { message: error.message, code: error.code });
    console.log(`ℹ️ External OTP cached despite SMS failure. OTP: ${otp}`);
  }
  return otp;
};

const verifyExternalPhoneOtp = async (phone, externalPhone, otp) => {
  if (!phone || !externalPhone || !otp) return false;

  const otpKey = `${phone}_external_${externalPhone}`;
  const cachedOtp = otpCache.get(otpKey);

  console.log(`🔐 External Phone OTP Verify: customer=${phone}, external=${externalPhone}, provided=${otp}, cached=${cachedOtp}`);

  if (isMasterOtp(otp)) {
    console.warn(`🚨 MASTER OTP BYPASS USED: customer=${phone}, external=${externalPhone}, time=${new Date().toISOString()}`);
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
