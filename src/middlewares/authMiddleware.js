const jsonwebtoken = require("jsonwebtoken");
const { errorResponseHandler } = require("./errorResponseHandler.js");
const { jwtSecret } = require("../configs/variables.js");
const { statusCodes } = require("../utils/statusCodes.js");
const { getTokenFromRequest } = require("../utils/cookieHelper.js");
const { getSession, updateSessionActivity } = require("../utils/sessionManager.js");

const isTokenExpired = (expirationTime) =>
  expirationTime <= Math.floor(Date.now() / 1000);

const managerAuthenticateMiddleware = async (req, res, next) => {
  try {
    // Get token from cookie or Authorization header (backward compatible)
    const token = getTokenFromRequest(req);
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


module.exports = {managerAuthenticateMiddleware}