const jsonwebtoken = require("jsonwebtoken");
const { errorResponseHandler } = require("./errorResponseHandler.js");
const { jwtSecret } = require("../configs/variables.js");
const { statusCodes } = require("../utils/statusCodes.js");
const { getTokenFromRequest } = require("../utils/cookieHelper.js");
const { getSession, updateSessionActivity } = require("../utils/sessionManager.js");
const { authenticateCustomerToken } = require("../utils/customerAuth.js");

const isTokenExpired = (expirationTime) =>
  expirationTime <= Math.floor(Date.now() / 1000);

const managerAuthenticateMiddleware = async (req, res, next) => {
  try {
    // Get token from cookie or Authorization header (backward compatible).
    // 'manager_auth_token' is a distinct cookie name from admin sessions'
    // 'admin_auth_token' — both used to default to the shared 'auth_token'
    // name, so an admin login in the same browser would silently overwrite a
    // manager's cookie (shared COOKIE_DOMAIN), 401ing every manager request.
    const token = getTokenFromRequest(req, 'manager_auth_token');
    if (!token) {
      throw Object.assign(new Error(), {
        status: statusCodes.UNAUTHORIZED,
        error: { code: 40113 },
      });
    }

    let decoded;
    try {
      decoded = jsonwebtoken.verify(token, jwtSecret, { algorithms: ['HS256'] });

      if (isTokenExpired(decoded.exp)) {
        throw Object.assign(new Error(), {
          status: statusCodes.UNAUTHORIZED,
          error: { code: 40110 },
        });
      }

      if (decoded.role !== "manager") {
        throw Object.assign(new Error(), {
          status: statusCodes.UNAUTHORIZED,
          error: { code: 40114 },
        });
      }
    } catch (error) {
      if (error.name === "TokenExpiredError") {
        throw Object.assign(new Error(), {
          status: statusCodes.UNAUTHORIZED,
          error: { code: 40110 },
        });
      } else if (error.status) {
        throw error;
      } else {
        throw Object.assign(new Error(), {
          status: statusCodes.UNAUTHORIZED,
          error: { code: 40111 },
        });
      }
    }

    // Enforce the Redis-backed session so logout/invalidateSession actually
    // revokes access instead of leaving a still-valid JWT usable elsewhere.
    const session = await getSession(decoded.id);
    if (!session || session.token !== token) {
      throw Object.assign(new Error(), {
        status: statusCodes.UNAUTHORIZED,
        error: { code: 40115 },
      });
    }
    // Must be awaited: a fire-and-forget GET+SETEX here can finish after a
    // concurrent logout's DEL, silently resurrecting the session it just
    // invalidated. Awaiting serializes the touch before the request proceeds.
    await updateSessionActivity(decoded.id).catch(() => {});

    req.user = decoded;
    return next();
  } catch (err) {
    errorResponseHandler(err, req, res);
  }
};


// Verifies the short-lived customer session issued after OTP verification
// (see otp.controller.js:verifyPhoneOtpController). No Redis-backed session
// record is enforced here — unlike staff logins there's no "logout" action in
// the customer flow to invalidate early, so the short JWT expiry alone is the
// revocation mechanism. req.customerPhone is set from the verified token, not
// from any client-supplied value, so downstream handlers can trust it as
// proof of OTP ownership.
const customerAuthenticateMiddleware = async (req, res, next) => {
  try {
    const token = getTokenFromRequest(req, 'customer_auth_token');
    let auth;
    try {
      // Validates the signed JWT AND the revocable Redis session (the SAME
      // implementation the socket uses). Rejects legacy stateless tokens
      // (no sid/jti), revoked/expired sessions, and forged tokens.
      auth = await authenticateCustomerToken(token);
    } catch (err) {
      throw Object.assign(new Error(), {
        status: statusCodes.UNAUTHORIZED,
        error: { code: err.code === 'NO_TOKEN' ? 40116 : 40117 },
      });
    }
    req.customerPhone = auth.phone;
    req.customerSessionId = auth.sid;
    return next();
  } catch (err) {
    errorResponseHandler(err, req, res);
  }
};

// Accepts either session on routes legitimately called from both panels
// (e.g. /customer/find-phone, /customer/find-email — the customer's own
// change-contact flow AND the manager's change-request duplicate check both
// hit these). Dispatches on whichever cookie is present rather than
// duplicating routes/controllers per caller.
const customerOrManagerAuthenticateMiddleware = async (req, res, next) => {
  const customerToken = getTokenFromRequest(req, 'customer_auth_token');
  if (customerToken) {
    return customerAuthenticateMiddleware(req, res, next);
  }
  return managerAuthenticateMiddleware(req, res, next);
};

module.exports = { managerAuthenticateMiddleware, customerAuthenticateMiddleware, customerOrManagerAuthenticateMiddleware }