const jwt = require('jsonwebtoken');
const { getTokenFromRequest } = require('../utils/cookieHelper');
const { getSession, updateSessionActivity } = require('../utils/sessionManager');

const { jwtSecret } = require('../configs/variables');

// Enforces the Redis-backed session so invalidateSession() (logout, forced
// password reset) actually revokes a still-unexpired JWT.
const enforceSession = async (decoded, token) => {
  const session = await getSession(decoded.id);
  return session && session.token === token;
};

const adminAuthenticateMiddleware = async (req, res, next) => {
  try {
    // Get token from cookie or Authorization header (backward compatible).
    // 'admin_auth_token' is distinct from manager sessions' 'manager_auth_token'
    // to avoid a shared-COOKIE_DOMAIN collision (see authMiddleware.js).
    const token = getTokenFromRequest(req, 'admin_auth_token');

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });

    if (decoded.type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Admin privileges required.'
      });
    }

    if (!(await enforceSession(decoded, token))) {
      return res.status(401).json({
        success: false,
        code: 'SESSION_SUPERSEDED',
        message: 'This account was logged in elsewhere, ending this session'
      });
    }
    // Awaited to avoid a race with a concurrent logout's invalidateSession DEL
    // (see authMiddleware.js) that could otherwise resurrect a revoked session.
    await updateSessionActivity(decoded.id).catch(() => {});

    req.admin = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired'
      });
    }
    return res.status(401).json({
      success: false,
      message: 'Invalid token'
    });
  }
};

const supervisorAuthMiddleware = async (req, res, next) => {
  try {
    // Get token from cookie or Authorization header (backward compatible)
    const token = getTokenFromRequest(req, 'admin_auth_token');

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });

    if (decoded.type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Admin privileges required.'
      });
    }

    if (!['super_admin', 'supervisor'].includes(decoded.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Supervisor privileges required.'
      });
    }

    if (!(await enforceSession(decoded, token))) {
      return res.status(401).json({
        success: false,
        code: 'SESSION_SUPERSEDED',
        message: 'This account was logged in elsewhere, ending this session'
      });
    }
    // Awaited to avoid a race with a concurrent logout's invalidateSession DEL
    // (see authMiddleware.js) that could otherwise resurrect a revoked session.
    await updateSessionActivity(decoded.id).catch(() => {});

    req.admin = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired'
      });
    }
    return res.status(401).json({
      success: false,
      message: 'Invalid token'
    });
  }
};

const superAdminAuthMiddleware = async (req, res, next) => {
  try {
    const token = getTokenFromRequest(req, 'admin_auth_token');

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });

    if (decoded.type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Admin privileges required.'
      });
    }

    if (decoded.role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Super admin privileges required.'
      });
    }

    if (!(await enforceSession(decoded, token))) {
      return res.status(401).json({
        success: false,
        message: 'Session expired or logged out'
      });
    }
    // Awaited to avoid a race with a concurrent logout's invalidateSession DEL
    // (see authMiddleware.js) that could otherwise resurrect a revoked session.
    await updateSessionActivity(decoded.id).catch(() => {});

    req.admin = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired'
      });
    }
    return res.status(401).json({
      success: false,
      message: 'Invalid token'
    });
  }
};

module.exports = {
  adminAuthenticateMiddleware,
  supervisorAuthMiddleware,
  superAdminAuthMiddleware
};
