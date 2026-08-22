const jwt = require("jsonwebtoken");
const { errorResponseHandler } = require("../middlewares/errorResponseHandler");
const OTP = require("../services/otpService");
const { statusCodes } = require("../utils/statusCodes");
const { jwtSecret } = require("../configs/variables");
const { setAuthCookie } = require("../utils/cookieHelper");
const { getCustomerSessions } = require("../utils/customerSession");
const { getOtpChallenges } = require("../utils/otpChallenge");
const { getVerificationGrants } = require("../utils/verificationGrant");

// Mints a purpose-bound, single-use verification grant when a change flow's OTP
// verify succeeds (Phase 3). The sensitive change handler later consumes it
// before touching CBS, so faking the verify response can't complete the change.
// An unknown purpose is rejected rather than silently skipped (a skipped grant
// would block the legitimate approval).
const issueVerificationGrantIfRequested = async (purpose, value) => {
  if (!purpose) return;
  const grants = getVerificationGrants();
  if (!grants.isValidPurpose(purpose)) {
    throw Object.assign(new Error("Unknown verification purpose"), {
      status: statusCodes.BAD_REQUEST,
      error: { code: 40011 },
    });
  }
  await grants.grant(purpose, value);
};

// Video-KYC sessions run a phone-verify -> call -> face-compare sequence that
// should complete well inside this window; short-lived by design since there's
// no logout step in the customer flow to revoke it early.
const CUSTOMER_SESSION_MAX_AGE_MS = 30 * 60 * 1000;

// Phase 2 challenge gate for the verify controllers. Verification is bound to a
// server-issued challenge id (see utils/otpChallenge.js): the id must be present
// AND resolve to the claimed target, or verification is rejected before any OTP
// check. Every /otp/send response returns a challengeId for its verify to use.
const requireOtpChallenge = async (challengeId, type, target) => {
  const challenge = challengeId
    ? await getOtpChallenges().resolve(challengeId, type, target)
    : null;
  if (!challenge) {
    throw Object.assign(new Error("Invalid or expired verification challenge"), {
      status: statusCodes.BAD_REQUEST,
      error: { code: 40011 },
    });
  }
};
const sendOtpController = async (req, res) => {
  try {
    const { email, checkDuplicate } = req.body;

    if (!email) {
      throw Object.assign(new Error("Email Address is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40010 },
      });
    }

    // When used for email change, check if email is already registered
    if (checkDuplicate) {
      const { checkEmailExists } = require("../services/customerService");
      const existingAccounts = await checkEmailExists(email);
      if (existingAccounts && existingAccounts.length > 0) {
        throw Object.assign(
          new Error("This email is already registered to another account"),
          {
            status: statusCodes.BAD_REQUEST,
            error: { code: 40015 },
          }
        );
      }
    }

    try {
      await OTP.sendOTP(email);
      // Phase 2: bind this send to an unguessable challenge id the client must
      // present at verify time (see utils/otpChallenge.js).
      const challengeId = await getOtpChallenges().issue("email", email);
      return res.success({ email, challengeId }, "OTP sent successfully.");
    } catch (otpError) {
      // If error already has status, preserve it; otherwise set to 400
      if (!otpError.status) {
        otpError.status = statusCodes.BAD_REQUEST;
        otpError.error = { code: 40014 };
      }
      throw otpError;
    }
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const sendPhoneOtpController = async (req, res) => {
  try {
    const { phone, checkDuplicate } = req.body;
    if (!phone) {
      throw Object.assign(new Error("Phone number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }

    // When used for phone change, check if number is already registered
    // allowDuplicate: true lets a customer keep the same number across multiple accounts
    if (checkDuplicate && !req.body.allowDuplicate) {
      const { getAccountsListByPhone } = require("../services/customerService");
      const existingAccounts = await getAccountsListByPhone(phone);
      if (existingAccounts && existingAccounts.length > 0) {
        throw Object.assign(
          new Error("This phone number is already registered to another account. If the customer needs to keep this number across accounts, enable override."),
          {
            status: statusCodes.CONFLICT,
            error: { code: 40015, allowOverride: true },
          }
        );
      }
    }

    await OTP.sendtPhoneOtp(phone);
    // Phase 2: bind this send to an unguessable challenge id the client must
    // present at verify time (see utils/otpChallenge.js).
    const challengeId = await getOtpChallenges().issue("phone", phone);
    return res.success({ phone, challengeId }, "OTP sent successfully.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const verifyPhoneOtpController = async (req, res) => {
  try {
    const { phone, otp, isChangeRequest, challengeId, purpose } = req.body;
    if (!phone) {
      throw Object.assign(new Error("Phone number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }
    if (!otp) {
      throw Object.assign(new Error("OTP is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40013 },
      });
    }

    // Phase 2: the challenge id must resolve to THIS phone.
    await requireOtpChallenge(challengeId, "phone", phone);

    const isVerified = await OTP.verifyPhoneOtp(phone, otp);
    if (!isVerified) {
      // Per-challenge attempt cap (#14) — burns the challenge after too many misses.
      await getOtpChallenges().recordFailedAttempt(challengeId);
      throw Object.assign(new Error("Invalid or expired OTP"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40011 },
      });
    }

    // OTP matched — retire the single-use challenge so it can't be replayed.
    await getOtpChallenges().consume(challengeId);

    // Record server-side proof so the socket `customer:phone-verified` event can
    // require it rather than trusting the client's assertion.
    await OTP.markContactVerified("phone", phone);

    // Phase 3: for a change flow, mint the purpose-bound grant the CBS-write
    // handler will require (e.g. CHANGE_PHONE bound to this new number).
    await issueVerificationGrantIfRequested(purpose, phone);

    // A mid-call "change phone" verification proves ownership of the NEW,
    // not-yet-manager-approved number — it must not re-issue the session
    // cookie under that number, or the customer's socket re-authenticates
    // as the new (unapproved) phone on its next reconnect, orphaning the
    // in-progress call and silently breaking every request the customer
    // submits for the rest of the session (address/dormant/email included).
    if (!isChangeRequest) {
      // Bind the JWT to a revocable server-side session (sid + jti). issue()
      // also revokes any previous session for this number, so a fresh OTP login
      // invalidates the old token.
      const { sid, jti } = await getCustomerSessions().issue(phone);
      const token = jwt.sign({ phone, role: "customer", sid, jti }, jwtSecret, {
        expiresIn: `${CUSTOMER_SESSION_MAX_AGE_MS / 1000}s`,
      });
      setAuthCookie(res, token, CUSTOMER_SESSION_MAX_AGE_MS, "customer_auth_token");
    }

    res.success({ isVerified }, "Verification Successful.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const verifyEmailController = async (req, res) => {
  try {
    const { email, otp, phone, isChangeRequest, challengeId, purpose } = req.body;

    // Support both email and phone-based email verification
    let emailToVerify = email;
    if (!emailToVerify && phone) {
      // If phone provided, get email from customer service
      const { getAccountsListByPhone } = require("../services/customerService");
      const accounts = await getAccountsListByPhone(phone);
      if (accounts.length > 0 && accounts[0].email) {
        emailToVerify = accounts[0].email;
      }
    }

    if (!emailToVerify) {
      throw Object.assign(new Error("Email is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40010 },
      });
    }

    if (!otp) {
      throw Object.assign(new Error("OTP is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40013 },
      });
    }

    // Phase 2: same challenge binding as verify-phone, keyed on the resolved
    // email address.
    await requireOtpChallenge(challengeId, "email", emailToVerify);

    const isVerified = await OTP.verifyOTP(emailToVerify, otp);

    if (!isVerified) {
      // Per-challenge attempt cap (#14) — burns the challenge after too many misses.
      await getOtpChallenges().recordFailedAttempt(challengeId);
      throw Object.assign(new Error("Invalid or expired OTP"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40011 },
      });
    }

    // OTP matched — retire the single-use challenge so it can't be replayed.
    await getOtpChallenges().consume(challengeId);

    // Record server-side proof so the socket `customer:email-verified` event can
    // require it rather than trusting the client's assertion.
    await OTP.markContactVerified("email", emailToVerify);

    // Phase 3: for a change flow, mint the purpose-bound grant the CBS-write
    // handler will require (e.g. CHANGE_EMAIL bound to this new address).
    await issueVerificationGrantIfRequested(purpose, emailToVerify);

    // Email is a standalone entry method (StartVerification lets the customer
    // choose phone OR email), so it must mint the same short-lived session the
    // phone path does — otherwise an email-verified customer reaches the socket
    // handshake with no signed token and is (now) rejected there. The email is
    // used as the customer identifier throughout the call flow, so it goes into
    // the `phone` claim, matching how the rest of the system keys email-only
    // customers. A mid-call "change email" verification (isChangeRequest) must
    // NOT re-issue the session under the new, not-yet-approved address — same
    // rationale as verifyPhoneOtpController.
    if (!isChangeRequest) {
      const { sid, jti } = await getCustomerSessions().issue(emailToVerify);
      const token = jwt.sign({ phone: emailToVerify, role: "customer", sid, jti }, jwtSecret, {
        expiresIn: `${CUSTOMER_SESSION_MAX_AGE_MS / 1000}s`,
      });
      setAuthCookie(res, token, CUSTOMER_SESSION_MAX_AGE_MS, "customer_auth_token");
    }

    return res.success(
      { isEmailVerified: isVerified },
      "Email verified successfully"
    );
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const sendExternalPhoneOtpController = async (req, res) => {
  try {
    const { phone, externalPhone } = req.body;

    if (!phone) {
      throw Object.assign(new Error("Customer phone number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }

    if (!externalPhone) {
      throw Object.assign(new Error("External phone number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }

    await OTP.sendExternalPhoneOtp(phone, externalPhone);
    return res.success(
      { phone, externalPhone },
      "OTP sent to external phone successfully. This number is not visible to the agent."
    );
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const verifyExternalPhoneOtpController = async (req, res) => {
  try {
    const { phone, externalPhone, otp } = req.body;

    if (!phone) {
      throw Object.assign(new Error("Customer phone number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }

    if (!externalPhone) {
      throw Object.assign(new Error("External phone number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }

    if (!otp) {
      throw Object.assign(new Error("OTP is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40013 },
      });
    }

    const isVerified = await OTP.verifyExternalPhoneOtp(phone, externalPhone, otp);

    if (!isVerified) {
      throw Object.assign(new Error("Invalid or expired OTP"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40011 },
      });
    }

    return res.success(
      { isVerified },
      "External phone OTP verified successfully"
    );
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

module.exports = {
  sendOtpController,
  sendPhoneOtpController,
  verifyPhoneOtpController,
  verifyEmailController,
  sendExternalPhoneOtpController,
  verifyExternalPhoneOtpController,
};
