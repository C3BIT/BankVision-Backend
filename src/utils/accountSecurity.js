/**
 * Account Security Utilities
 * Handles account lockout and password history
 */
const bcrypt = require('bcryptjs');

// Configuration
const SECURITY_CONFIG = {
  maxFailedAttempts: 5,           // Lock after 5 failed attempts
  lockoutDurationMinutes: 30,     // Lock for 30 minutes
  passwordHistoryCount: 5,        // Remember last 5 passwords
  failedAttemptResetMinutes: 15   // Reset failed count after 15 mins of no attempts
};

/**
 * Check if account is currently locked
 * @param {object} user - User model instance
 * @returns {object} - { isLocked: boolean, remainingMinutes: number, message: string }
 */
const checkAccountLocked = (user) => {
  if (!user.lockedUntil) {
    return { isLocked: false };
  }

  const now = new Date();
  const lockExpiry = new Date(user.lockedUntil);

  if (now < lockExpiry) {
    const remainingMs = lockExpiry - now;
    const remainingMinutes = Math.ceil(remainingMs / (1000 * 60));

    return {
      isLocked: true,
      remainingMinutes,
      message: `Account is locked. Try again in ${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''}.`
    };
  }

  // Lock has expired
  return { isLocked: false, wasLocked: true };
};

/**
 * Record a failed login attempt
 * @param {object} user - User model instance
 * @returns {object} - { locked: boolean, attemptsRemaining: number, message: string }
 */
const recordFailedAttempt = async (user) => {
  const now = new Date();

  // Check if we should reset the counter (no attempts for X minutes)
  if (user.lastFailedLogin) {
    const lastAttempt = new Date(user.lastFailedLogin);
    const minutesSinceLastAttempt = (now - lastAttempt) / (1000 * 60);

    if (minutesSinceLastAttempt > SECURITY_CONFIG.failedAttemptResetMinutes) {
      user.failedLoginAttempts = 0;
    }
  }

  // Increment failed attempts
  user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
  user.lastFailedLogin = now;

  // Check if account should be locked
  if (user.failedLoginAttempts >= SECURITY_CONFIG.maxFailedAttempts) {
    const lockUntil = new Date(now.getTime() + SECURITY_CONFIG.lockoutDurationMinutes * 60 * 1000);
    user.lockedUntil = lockUntil;

    await user.save();

    console.log(`🔒 Account locked for ${user.email} after ${user.failedLoginAttempts} failed attempts`);

    return {
      locked: true,
      attemptsRemaining: 0,
      message: `Account locked due to too many failed attempts. Try again in ${SECURITY_CONFIG.lockoutDurationMinutes} minutes.`
    };
  }

  await user.save();

  const attemptsRemaining = SECURITY_CONFIG.maxFailedAttempts - user.failedLoginAttempts;

  return {
    locked: false,
    attemptsRemaining,
    message: `Invalid credentials. ${attemptsRemaining} attempt${attemptsRemaining > 1 ? 's' : ''} remaining.`
  };
};

/**
 * Record a successful login (resets failed attempts)
 * @param {object} user - User model instance
 */
const recordSuccessfulLogin = async (user) => {
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  user.lastFailedLogin = null;
  user.lastLogin = new Date();

  await user.save();

  console.log(`✅ Successful login for ${user.email}`);
};

/**
 * Unlock an account (admin function)
 * @param {object} user - User model instance
 */
const unlockAccount = async (user) => {
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  user.lastFailedLogin = null;

  await user.save();

  console.log(`🔓 Account unlocked for ${user.email}`);
};

/**
 * Check if password was used before
 * @param {string} newPassword - The new password (plain text)
 * @param {array} passwordHistory - Array of previous password hashes
 * @returns {boolean} - True if password was used before
 */
const isPasswordInHistory = async (newPassword, passwordHistory = []) => {
  if (!passwordHistory || passwordHistory.length === 0) {
    return false;
  }

  for (const oldHash of passwordHistory) {
    const isMatch = await bcrypt.compare(newPassword, oldHash);
    if (isMatch) {
      return true;
    }
  }

  return false;
};

/**
 * Add password to history
 * @param {string} hashedPassword - The hashed password to add
 * @param {array} currentHistory - Current password history array
 * @returns {array} - Updated password history (limited to config count)
 */
const addToPasswordHistory = (hashedPassword, currentHistory = []) => {
  const history = [...(currentHistory || [])];
  history.unshift(hashedPassword);

  // Keep only the configured number of passwords
  return history.slice(0, SECURITY_CONFIG.passwordHistoryCount);
};

/**
 * Validate password change (check history)
 * @param {string} newPassword - New password (plain text)
 * @param {string} currentHash - Current password hash
 * @param {array} passwordHistory - Previous password hashes
 * @returns {object} - { valid: boolean, message: string }
 */
const validatePasswordChange = async (newPassword, currentHash, passwordHistory = []) => {
  // Check against current password
  const matchesCurrent = await bcrypt.compare(newPassword, currentHash);
  if (matchesCurrent) {
    return {
      valid: false,
      message: 'New password cannot be the same as your current password'
    };
  }

  // Check against password history
  const inHistory = await isPasswordInHistory(newPassword, passwordHistory);
  if (inHistory) {
    return {
      valid: false,
      message: `Password was used recently. Please choose a different password (cannot reuse last ${SECURITY_CONFIG.passwordHistoryCount} passwords)`
    };
  }

  return { valid: true };
};

module.exports = {
  SECURITY_CONFIG,
  checkAccountLocked,
  recordFailedAttempt,
  recordSuccessfulLogin,
  unlockAccount,
  isPasswordInHistory,
  addToPasswordHistory,
  validatePasswordChange
};
