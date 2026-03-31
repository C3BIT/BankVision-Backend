/**
 * Password Policy Configuration
 * Compliant with banking security standards
 */
const PASSWORD_POLICY = {
  minLength: 8,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSpecialChars: true,
  specialChars: '!@#$%^&*()_+-=[]{}|;:,.<>?',
  preventCommonPasswords: true,
  maxConsecutiveChars: 3, // Prevent "aaa", "111", etc.
  historyCount: 5 // Number of previous passwords to check against
};

// Common weak passwords to block
const COMMON_PASSWORDS = [
  'password', 'password1', 'password123', '123456', '12345678', 'qwerty',
  'abc123', 'letmein', 'welcome', 'admin', 'admin123', 'root', 'toor',
  'pass', 'test', 'guest', 'master', 'changeme', 'password!', 'p@ssw0rd'
];

/**
 * Validate password against policy
 * @param {string} password - The password to validate
 * @returns {object} - { isValid: boolean, errors: string[] }
 */
const validatePassword = (password) => {
  const errors = [];

  if (!password) {
    return { isValid: false, errors: ['Password is required'] };
  }

  // Length check
  if (password.length < PASSWORD_POLICY.minLength) {
    errors.push(`Password must be at least ${PASSWORD_POLICY.minLength} characters`);
  }

  if (password.length > PASSWORD_POLICY.maxLength) {
    errors.push(`Password must not exceed ${PASSWORD_POLICY.maxLength} characters`);
  }

  // Uppercase check
  if (PASSWORD_POLICY.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }

  // Lowercase check
  if (PASSWORD_POLICY.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }

  // Numbers check
  if (PASSWORD_POLICY.requireNumbers && !/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  // Special characters check
  if (PASSWORD_POLICY.requireSpecialChars) {
    const specialCharsRegex = new RegExp(`[${PASSWORD_POLICY.specialChars.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}]`);
    if (!specialCharsRegex.test(password)) {
      errors.push('Password must contain at least one special character (!@#$%^&*()_+-=[]{}|;:,.<>?)');
    }
  }

  // Common passwords check
  if (PASSWORD_POLICY.preventCommonPasswords) {
    const lowerPassword = password.toLowerCase();
    if (COMMON_PASSWORDS.some(common => lowerPassword.includes(common))) {
      errors.push('Password is too common or easily guessable');
    }
  }

  // Consecutive characters check
  if (PASSWORD_POLICY.maxConsecutiveChars > 0) {
    const consecutiveRegex = new RegExp(`(.)\\1{${PASSWORD_POLICY.maxConsecutiveChars},}`);
    if (consecutiveRegex.test(password)) {
      errors.push(`Password cannot contain more than ${PASSWORD_POLICY.maxConsecutiveChars} consecutive identical characters`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
};

/**
 * Get password strength score (0-100)
 * @param {string} password - The password to check
 * @returns {object} - { score: number, strength: string }
 */
const getPasswordStrength = (password) => {
  let score = 0;

  if (!password) return { score: 0, strength: 'Very Weak' };

  // Length bonus
  if (password.length >= 8) score += 20;
  if (password.length >= 12) score += 10;
  if (password.length >= 16) score += 10;

  // Character type bonuses
  if (/[a-z]/.test(password)) score += 10;
  if (/[A-Z]/.test(password)) score += 15;
  if (/[0-9]/.test(password)) score += 15;
  if (/[^a-zA-Z0-9]/.test(password)) score += 20;

  // Variety bonus
  const uniqueChars = new Set(password).size;
  if (uniqueChars >= 8) score += 10;

  // Cap at 100
  score = Math.min(100, score);

  let strength;
  if (score < 30) strength = 'Very Weak';
  else if (score < 50) strength = 'Weak';
  else if (score < 70) strength = 'Fair';
  else if (score < 90) strength = 'Strong';
  else strength = 'Very Strong';

  return { score, strength };
};

/**
 * Generate password requirements message
 * @returns {string} - Human readable requirements
 */
const getPasswordRequirements = () => {
  const requirements = [];

  requirements.push(`At least ${PASSWORD_POLICY.minLength} characters`);
  if (PASSWORD_POLICY.requireUppercase) requirements.push('One uppercase letter');
  if (PASSWORD_POLICY.requireLowercase) requirements.push('One lowercase letter');
  if (PASSWORD_POLICY.requireNumbers) requirements.push('One number');
  if (PASSWORD_POLICY.requireSpecialChars) requirements.push('One special character');

  return requirements.join(', ');
};

module.exports = {
  PASSWORD_POLICY,
  validatePassword,
  getPasswordStrength,
  getPasswordRequirements
};
