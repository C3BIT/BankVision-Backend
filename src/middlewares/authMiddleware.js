const jsonwebtoken = require("jsonwebtoken");
const { errorResponseHandler } = require("./errorResponseHandler.js");
const { jwtSecret } = require("../configs/variables.js");
const { statusCodes } = require("../utils/statusCodes.js");
const { getTokenFromRequest } = require("../utils/cookieHelper.js");

const isTokenExpired = (expirationTime) =>
  expirationTime <= Math.floor(Date.now() / 1000);

const managerAuthenticateMiddleware = (req, res, next) => {
  try {
    // Get token from cookie or Authorization header (backward compatible)
    const token = getTokenFromRequest(req);
    if (!token) {
      throw Object.assign(new Error(), {
        status: statusCodes.UNAUTHORIZED,
        error: { code: 40113 },
      });
    }

    try {
      const decoded = jsonwebtoken.verify(token, jwtSecret, { algorithms: ['HS256'] });

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