/**
 * Cookie Helper - Secure JWT token management via httpOnly cookies
 */

/**
 * Set JWT token as httpOnly cookie
 * @param {object} res - Express response object
 * @param {string} token - JWT token
 * @param {number} maxAge - Cookie max age in milliseconds (default 8 hours)
 * @param {string} cookieName - Cookie name (default 'auth_token'; customer sessions use a
 *   distinct name so a staff and a customer session in the same browser don't overwrite
 *   each other, since both cookies are set against the shared api.* host)
 */
const setAuthCookie = (res, token, maxAge = 8 * 60 * 60 * 1000, cookieName = 'auth_token') => {
  // sameSite:'none' requires secure:true per browser spec — always true when using cross-origin cookies
  const secure = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
  res.cookie(cookieName, token, {
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
 * @param {string} cookieName - Cookie name (default 'auth_token')
 */
const clearAuthCookie = (res, cookieName = 'auth_token') => {
  const secure = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
  res.clearCookie(cookieName, {
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
 * @param {string} cookieName - Cookie name to read (default 'auth_token')
 * @returns {string|null} - JWT token or null
 */
const getTokenFromRequest = (req, cookieName = 'auth_token') => {
  // 1. Try Authorization header (preferred for API clients)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }

  // 2. Try query param (for video players that can't send headers)
  if (req.query && req.query.token) {
    return req.query.token;
  }

  // 3. Try cookie
  if (req.cookies && req.cookies[cookieName]) {
    return req.cookies[cookieName];
  }

  return null;
};

module.exports = {
  setAuthCookie,
  clearAuthCookie,
  getTokenFromRequest
};
