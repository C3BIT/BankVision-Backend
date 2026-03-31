/**
 * Password Expiry Middleware - Enforce 90-day password rotation
 * Complies with PCI-DSS 8.2.4 and banking security best practices
 */

const { statusCodes } = require('../utils/statusCodes');

/**
 * Check if password has expired (90 days)
 * @param {Date} passwordChangedAt - Last password change date
 * @returns {Object} - { isExpired: boolean, daysRemaining: number }
 */
const checkPasswordExpiry = (passwordChangedAt) => {
  const PASSWORD_EXPIRY_DAYS = 90;
  const WARNING_DAYS = 7; // Warn user when < 7 days remaining

  if (!passwordChangedAt) {
    // If no password change date, assume password is expired
    return { isExpired: true, daysRemaining: 0, showWarning: false };
  }

  const now = new Date();
  const passwordAge = Math.floor((now - new Date(passwordChangedAt)) / (1000 * 60 * 60 * 24));
  const daysRemaining = PASSWORD_EXPIRY_DAYS - passwordAge;

  return {
    isExpired: daysRemaining <= 0,
    daysRemaining: Math.max(0, daysRemaining),
    showWarning: daysRemaining > 0 && daysRemaining <= WARNING_DAYS
  };
};

/**
 * Middleware to check password expiry for managers
 * Blocks access if password has expired
 */
const checkManagerPasswordExpiry = (req, res, next) => {
  try {
    const user = req.user; // Set by authMiddleware

    if (!user) {
      return next(); // Let auth middleware handle missing user
    }

    // Get password change date from user object (set by auth middleware if available)
    const passwordChangedAt = user.passwordChangedAt;

    const expiryStatus = checkPasswordExpiry(passwordChangedAt);

    if (expiryStatus.isExpired) {
      return res.status(statusCodes.FORBIDDEN).json({
        success: false,
        message: 'Your password has expired. Please change your password to continue.',
        error: {
          code: 40303,
          passwordExpired: true,
          requiresPasswordChange: true
        }
      });
    }

    if (expiryStatus.showWarning) {
      // Add warning to response headers for frontend to display
      res.setHeader('X-Password-Expiry-Warning', 'true');
      res.setHeader('X-Password-Days-Remaining', expiryStatus.daysRemaining.toString());
    }

    next();
  } catch (error) {
    console.error('Password expiry check error:', error);
    next(); // Fail open - don't block access on middleware errors
  }
};

/**
 * Middleware to check password expiry for admins
 * Blocks access if password has expired
 */
const checkAdminPasswordExpiry = (req, res, next) => {
  try {
    const admin = req.admin; // Set by adminAuthMiddleware

    if (!admin) {
      return next(); // Let auth middleware handle missing admin
    }

    const passwordChangedAt = admin.passwordChangedAt;

    const expiryStatus = checkPasswordExpiry(passwordChangedAt);

    if (expiryStatus.isExpired) {
      return res.status(statusCodes.FORBIDDEN).json({
        success: false,
        message: 'Your password has expired. Please change your password to continue.',
        error: {
          code: 40303,
          passwordExpired: true,
          requiresPasswordChange: true
        }
      });
    }

    if (expiryStatus.showWarning) {
      res.setHeader('X-Password-Expiry-Warning', 'true');
      res.setHeader('X-Password-Days-Remaining', expiryStatus.daysRemaining.toString());
    }

    next();
  } catch (error) {
    console.error('Password expiry check error:', error);
    next(); // Fail open
  }
};

module.exports = {
  checkPasswordExpiry,
  checkManagerPasswordExpiry,
  checkAdminPasswordExpiry
};
