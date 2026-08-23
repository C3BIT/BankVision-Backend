const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { errorResponseHandler } = require('../middlewares/errorResponseHandler');
const { statusCodes } = require('../utils/statusCodes');
const { jwtSecret } = require('../configs/variables');
const { setAuthCookie } = require('../utils/cookieHelper');
const { getCustomerSessions } = require('../utils/customerSession');
const { rsaDecrypt } = require('../utils/rsaHelper');
const { redisClient } = require('../configs/redis');
const { getAccountsListByPhone } = require('../services/customerService');
const { logAuthEvent, getClientIP } = require('../services/loggingService');

// Same window the OTP flow issues — this is a second way to establish the
// same customer_auth_token session, not a separate/longer-lived one.
const CUSTOMER_SESSION_MAX_AGE_MS = 30 * 60 * 1000;

// How long a given MTB Neo session_id is remembered to block replay of the
// same encrypted link. Confirm against MTB's actual link validity window
// once known; 5 minutes is a conservative default for a one-click handoff.
const SESSION_REPLAY_TTL_SECONDS = 5 * 60;

const REQUIRED_FIELDS = ['auth_key', 'session_id', 'cust_mob', 'cust_name'];

const fail = async (req, res, status, failureReason) => {
  await logAuthEvent({
    eventType: 'login_failed',
    userType: 'customer',
    ipAddress: getClientIP(req),
    userAgent: req.headers['user-agent'],
    failureReason,
    metadata: { flow: 'mtb_neo_sso' }
  });
  return res.status(status).json({ success: false });
};

/**
 * POST /api/sso/mtb-neo/authenticate
 * Exchanges an RSA-encrypted MTB Neo handshake payload for a customer_auth_token
 * session cookie, mirroring what otp.controller.js:verifyPhoneOtpController does
 * after OTP verification — this is an alternate way into the same session, not
 * a new auth mechanism the rest of the app needs to know about.
 */
const authenticateMtbNeo = async (req, res) => {
  try {
    const body = req.body || {};
    const missing = REQUIRED_FIELDS.filter((field) => !body[field]);
    if (missing.length > 0) {
      return fail(req, res, statusCodes.BAD_REQUEST, 'missing_param');
    }

    let authKey, sessionId, custMob, custName, custEmail;
    try {
      authKey = rsaDecrypt(body.auth_key);
      sessionId = rsaDecrypt(body.session_id);
      custMob = rsaDecrypt(body.cust_mob);
      custName = rsaDecrypt(body.cust_name);
      custEmail = body.cust_email ? rsaDecrypt(body.cust_email) : null;
    } catch (decryptError) {
      return fail(req, res, statusCodes.BAD_REQUEST, 'decrypt_error');
    }

    const expectedAuthKey = process.env.MTB_NEO_AUTH_KEY;
    if (!expectedAuthKey) {
      throw new Error('MTB_NEO_AUTH_KEY environment variable is required');
    }
    const authKeyBuf = Buffer.from(authKey);
    const expectedBuf = Buffer.from(expectedAuthKey);
    const authKeyValid =
      authKeyBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(authKeyBuf, expectedBuf);
    if (!authKeyValid) {
      return fail(req, res, statusCodes.UNAUTHORIZED, 'bad_auth_key');
    }

    const replayKey = `mtbneo:session:${sessionId}`;
    const setResult = await redisClient.set(replayKey, '1', 'EX', SESSION_REPLAY_TTL_SECONDS, 'NX');
    if (setResult !== 'OK') {
      return fail(req, res, statusCodes.UNAUTHORIZED, 'replay');
    }

    const accounts = await getAccountsListByPhone(custMob);
    if (!accounts || accounts.length === 0) {
      return fail(req, res, statusCodes.UNAUTHORIZED, 'cbs_mismatch');
    }

    // Bind the JWT to a revocable server-side session (sid + jti), exactly as
    // otp.controller does after OTP. Without this the SSO cookie was a stateless
    // token with no sid/jti — authenticateCustomerToken rejects those
    // (NO_SESSION_CLAIMS), so the cookie could never pass the HTTP/socket/LiveKit
    // gates. issue() also revokes any prior session for this number, so the SSO
    // handoff supersedes an older login rather than running beside it.
    const { sid, jti } = await getCustomerSessions().issue(custMob);
    const token = jwt.sign({ phone: custMob, role: 'customer', sid, jti }, jwtSecret, {
      expiresIn: `${CUSTOMER_SESSION_MAX_AGE_MS / 1000}s`,
    });
    setAuthCookie(res, token, CUSTOMER_SESSION_MAX_AGE_MS, 'customer_auth_token');

    await logAuthEvent({
      eventType: 'login_success',
      userType: 'customer',
      userPhone: custMob,
      ipAddress: getClientIP(req),
      userAgent: req.headers['user-agent'],
      sessionId,
      metadata: { flow: 'mtb_neo_sso' }
    });

    return res.success(
      { customer: { name: custName, mobile: custMob, email: custEmail } },
      'SSO authentication successful.'
    );
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

module.exports = {
  authenticateMtbNeo,
};
