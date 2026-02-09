const jsonwebtoken = require("jsonwebtoken");
const { errorResponseHandler } = require("./errorResponseHandler.js");
const { jwtSecret } = require("../configs/variables.js");
const { statusCodes } = require("../utils/statusCodes.js");
const { getTokenFromRequest } = require("../utils/cookieHelper.js");

const isTokenExpired = (expirationTime) =>
  expirationTime <= Math.floor(Date.now() / 1000);

const managerAuthenticateMiddleware = (req, res, next) => {
  try {
    // Debug logging
    console.log('🔐 Auth check for:', req.method, req.path);
    console.log('🍪 Cookies:', req.cookies ? Object.keys(req.cookies) : 'no cookies');
    console.log('🔑 Auth header:', req.headers.authorization ? 'present' : 'missing');

    // Get token from cookie or Authorization header (backward compatible)
    const token = getTokenFromRequest(req);
    if (!token) {
      console.log('❌ No token found in request');
      throw Object.assign(new Error(), {
        status: statusCodes.UNAUTHORIZED,
        error: { code: 40113 },
      });
    }
    console.log('✅ Token found, length:', token.length);

    try {
      const decoded = jsonwebtoken.verify(token, jwtSecret);

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

      req.user = decoded;
      return next();
    } catch (error) {
      if (error.name === "TokenExpiredError") {
        throw Object.assign(new Error(), {
          status: statusCodes.UNAUTHORIZED,
          error: { code: 40110 },
        });
      } else {
        throw Object.assign(new Error(), {
          status: statusCodes.UNAUTHORIZED,
          error: { code: 40111 },
        });
      }
    }
  } catch (err) {
    errorResponseHandler(err, req, res);
  }
};


module.exports = {managerAuthenticateMiddleware}