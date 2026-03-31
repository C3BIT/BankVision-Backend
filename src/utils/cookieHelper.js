/**
 * Cookie Helper - Secure JWT token management via httpOnly cookies
 */

/**
 * Set JWT token as httpOnly cookie
 * @param {object} res - Express response object
 * @param {string} token - JWT token
 * @param {number} maxAge - Cookie max age in milliseconds (default 8 hours)
 */
const setAuthCookie = (res, token, maxAge = 8 * 60 * 60 * 1000) => {
  // sameSite:'none' requires secure:true per browser spec — always true when using cross-origin cookies
  const secure = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
  res.cookie('auth_token', token, {
    httpOnly: true,        // Cannot be accessed by JavaScript
    secure: secure,
    sameSite: secure ? 'none' : 'lax', // 'none' only valid with secure flag
    maxAge: maxAge,        // Cookie expiration
    path: '/',             // Available for all routes
    domain: process.env.COOKIE_DOMAIN || undefined, // Share across subdomains if configured
  });
};

/**
 * Clear auth cookie (logout)
 * @param {object} res - Express response object
 */
const clearAuthCookie = (res) => {
  const secure = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
  res.clearCookie('auth_token', {
    httpOnly: true,
    secure: secure,
    sameSite: secure ? 'none' : 'lax',
    path: '/',
    domain: process.env.COOKIE_DOMAIN || undefined,
  });
};

/**
 * Get token from cookie or Authorization header (backward compatibility)
 * @param {object} req - Express request object
 * @returns {string|null} - JWT token or null
 */
const getTokenFromRequest = (req) => {
  // 1. Try Authorization header (preferred for API clients)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }

  // 2. Try cookie
  if (req.cookies && req.cookies.auth_token) {
    return req.cookies.auth_token;
  }

  return null;
};

module.exports = {
  setAuthCookie,
  clearAuthCookie,
  getTokenFromRequest
};
