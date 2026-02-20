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
  res.cookie('auth_token', token, {
    httpOnly: true,        // Cannot be accessed by JavaScript
    secure: process.env.NODE_ENV === 'production', // HTTPS only in production
    sameSite: 'none',      // Allow cross-subdomain (manager.X → api.X)
    maxAge: maxAge,        // Cookie expiration
    path: '/',             // Available for all routes
    domain: process.env.COOKIE_DOMAIN, // Share across all subdomains
  });
};

/**
 * Clear auth cookie (logout)
 * @param {object} res - Express response object
 */
const clearAuthCookie = (res) => {
  res.clearCookie('auth_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'none',
    path: '/',
    domain: process.env.COOKIE_DOMAIN,
  });
};

/**
 * Get token from cookie or Authorization header (backward compatibility)
 * @param {object} req - Express request object
 * @returns {string|null} - JWT token or null
 */
const getTokenFromRequest = (req) => {
  // 1. Try cookie (preferred)
  if (req.cookies && req.cookies.auth_token) {
    return req.cookies.auth_token;
  }

  // 2. Try Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }

  // 3. Try query param (for direct download links, etc.)
  if (req.query && req.query.token) {
    return req.query.token;
  }

  return null;
};

module.exports = {
  setAuthCookie,
  clearAuthCookie,
  getTokenFromRequest
};
