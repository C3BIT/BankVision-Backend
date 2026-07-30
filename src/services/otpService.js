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
const VERIFIED_MARKER_TTL = 900; // 15 minutes — window to consume a proven OTP

// Same normalization the socket layer applies (strip non-digits, drop BD
// country code, ensure a single leading 0) so a marker set from the REST
// controller keys identically to a lookup from the socket handler.
const normalizePhoneKey = (phone) => {
  if (!phone) return "";
  let cleaned = String(phone).replace(/\D/g, "");
  if (cleaned.startsWith("880") && cleaned.length > 10) cleaned = cleaned.substring(3);
  if (cleaned.startsWith("1") && cleaned.length === 10) cleaned = "0" + cleaned;
  return cleaned;
};

const verifiedMarkerKey = (type, value) =>
  type === "phone"
    ? `verified:phone:${normalizePhoneKey(value)}`
    : `verified:email:${String(value).toLowerCase().trim()}`;

// Called by the REST OTP-verify controllers on a genuine pass. It records
// server-side proof that THIS phone/email actually completed an OTP challenge,
// so the socket `customer:*-verified` events can require that proof instead of
// trusting the client's word (pentest finding: KYC "verified" flags were
// settable by simply emitting the socket event with no OTP).
const markContactVerified = async (type, value) => {
  await otpCache.set(verifiedMarkerKey(type, value), true, VERIFIED_MARKER_TTL);
};

// Called by the socket handler. Single-use: returns true only if a genuine OTP
// pass was recorded, and consumes it so the proof can't be replayed.
const consumeContactVerified = async (type, value) => {
  const key = verifiedMarkerKey(type, value);
  const proven = await otpCache.get(key);
  if (!proven) return false;
  await otpCache.del(key);
  return true;
};

// Master OTP bypass: a local-development-only escape hatch. It is DISABLED
// unless OTP_MASTER_BYPASS_ENABLED is explicitly set to "true" AND the process
// is not running in production. Because the flag is unset in every deployed
// (UAT/production) environment, the bypass does not exist there — closing the
// pentest's Critical finding #1, which previously stayed open because the
// bypass was hardcoded on with no environment safeguard. Any use is still
// logged loudly below for auditability.
const MASTER_OTP_ENABLED =
  process.env.OTP_MASTER_BYPASS_ENABLED === 'true' &&
  process.env.NODE_ENV !== 'production';
const isMasterOtp = (otp) => MASTER_OTP_ENABLED && String(otp) === '666666';

const attemptsKey = (key) => `${key}_attempts`;
const lockoutKey  = (key) => `${key}_locked`;

const checkLockout = async (key) => {
  if (await otpCache.get(lockoutKey(key))) {
    const err = new Error("Too many incorrect OTP attempts. Please request a new OTP after 15 minutes.");
    err.status = 429;
    err.error = { code: 40017 };
    throw err;
  }
};

const recordFailedAttempt = async (key) => {
  const attempts = (await otpCache.get(attemptsKey(key)) || 0) + 1;
  if (attempts >= MAX_OTP_ATTEMPTS) {
    await otpCache.del(key);
    await otpCache.del(attemptsKey(key));
    await otpCache.set(lockoutKey(key), true, LOCKOUT_TTL);
    const err = new Error("Too many incorrect OTP attempts. Please request a new OTP after 15 minutes.");
    err.status = 429;
    err.error = { code: 40017 };
    throw err;
  }
  await otpCache.set(attemptsKey(key), attempts, OTP_EXPIRY_TIME);
  return attempts;
};

const clearAttempts = async (key) => {
  await otpCache.del(attemptsKey(key));
  await otpCache.del(lockoutKey(key));
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
  await otpCache.del(otpKey);
  await otpCache.set(otpKey, otp, OTP_EXPIRY_TIME);
  await clearAttempts(otpKey);

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
  await checkLockout(otpKey);
  const cachedOTP = await otpCache.get(otpKey);

  console.log(`🔐 OTP Verify: email=${otpKey}, provided=${otp}, cached=${cachedOTP}`);

  if (isMasterOtp(otp)) {
    console.warn(`🚨 MASTER OTP BYPASS USED: email=${otpKey}, time=${new Date().toISOString()}`);
    await otpCache.del(otpKey);
    await clearAttempts(otpKey);
    return true;
  }

  if (!cachedOTP || String(cachedOTP) !== String(otp)) {
    const attempts = await recordFailedAttempt(otpKey);
    console.log(`❌ Email OTP failed (attempt ${attempts}/${MAX_OTP_ATTEMPTS})`);
    return false;
  }

  await otpCache.del(otpKey);
  await clearAttempts(otpKey);
  return true;
};

const sendtPhoneOtp = async (phone) => {
  const otp = generateOTP();
  await otpCache.del(phone);
  await otpCache.set(phone, otp, OTP_EXPIRY_TIME);
  await clearAttempts(phone);
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

  await checkLockout(phone);
  const cachedOtp = await otpCache.get(phone);
  console.log(`🔐 Phone OTP Verify: phone=${phone}, provided=${otp}, cached=${cachedOtp}`);

  if (isMasterOtp(otp)) {
    console.warn(`🚨 MASTER OTP BYPASS USED: phone=${phone}, time=${new Date().toISOString()}`);
    await otpCache.del(phone);
    await clearAttempts(phone);
    return true;
  }

  if (!cachedOtp || String(cachedOtp) !== String(otp)) {
    const attempts = await recordFailedAttempt(phone);
    console.log(`❌ Phone OTP failed (attempt ${attempts}/${MAX_OTP_ATTEMPTS}): cached=${cachedOtp}, provided=${otp}`);
    return false;
  }

  await otpCache.del(phone);
  await clearAttempts(phone);
  console.log(`✅ Phone OTP verified successfully for ${phone}`);
  return true;
};

const sendExternalPhoneOtp = async (phone, externalPhone) => {
  if (!phone || !externalPhone) {
    throw new Error("Phone and external phone are required");
  }

  const otp = generateOTP();
  const otpKey = `${phone}_external_${externalPhone}`;
  await otpCache.del(otpKey);
  await otpCache.set(otpKey, otp, OTP_EXPIRY_TIME);

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

  // Brute-force protection, matching verifyPhoneOtp/verifyOTP: this variant
  // previously had NO lockout and NO attempt counter, and its route had no rate
  // limiter — a 6-digit code was guessable at scale within the 180s TTL.
  await checkLockout(otpKey);

  const cachedOtp = await otpCache.get(otpKey);

  console.log(`🔐 External Phone OTP Verify: customer=${phone}, external=${externalPhone}, provided=${otp}, cached=${cachedOtp}`);

  if (isMasterOtp(otp)) {
    console.warn(`🚨 MASTER OTP BYPASS USED: customer=${phone}, external=${externalPhone}, time=${new Date().toISOString()}`);
    await otpCache.del(otpKey);
    await clearAttempts(otpKey);
    return true;
  }

  if (!cachedOtp || String(cachedOtp) !== String(otp)) {
    const attempts = await recordFailedAttempt(otpKey);
    console.log(`❌ External Phone OTP verification failed (attempt ${attempts}/${MAX_OTP_ATTEMPTS})`);
    return false;
  }

  await otpCache.del(otpKey);
  await clearAttempts(otpKey);
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
  markContactVerified,
  consumeContactVerified,
};
