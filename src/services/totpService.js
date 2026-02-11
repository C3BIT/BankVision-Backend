/**
 * TOTP Service - Time-based One-Time Password (Google Authenticator compatible)
 * Provides MFA support using TOTP (RFC 6238)
 *
 * Dependencies: npm install speakeasy qrcode
 */

const crypto = require('crypto');

/**
 * Generate TOTP secret for a user
 * @param {string} email - User's email
 * @param {string} appName - Application name (displayed in authenticator app)
 * @returns {object} - { secret, qrCodeUrl, backupCodes }
 */
const generateTOTPSecret = (email, appName = 'VBRM Banking') => {
  try {
    // In production, use speakeasy library:
    // const speakeasy = require('speakeasy');
    // const secret = speakeasy.generateSecret({
    //   name: `${appName} (${email})`,
    //   length: 32
    // });

    // For now, generate a simple base32 secret manually
    const secret = generateBase32Secret();

    // Generate otpauth URL for QR code
    const otpAuthUrl = `otpauth://totp/${encodeURIComponent(appName)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(appName)}`;

    // Generate backup codes (8 codes, 8 digits each)
    const backupCodes = generateBackupCodes(8);

    return {
      secret,
      otpAuthUrl,
      backupCodes,
      qrCodeDataUrl: null // Will be generated on frontend or using qrcode library
    };
  } catch (error) {
    console.error('TOTP secret generation error:', error);
    throw new Error('Failed to generate TOTP secret');
  }
};

/**
 * Verify TOTP token
 * @param {string} token - 6-digit TOTP token from user
 * @param {string} secret - User's TOTP secret
 * @param {number} window - Time window (default 1 = ±30 seconds)
 * @returns {boolean} - True if token is valid
 */
const verifyTOTP = (token, secret, window = 1) => {
  try {
    if (!token || !secret) {
      return false;
    }

    // In production, use speakeasy library:
    // const speakeasy = require('speakeasy');
    // return speakeasy.totp.verify({
    //   secret,
    //   encoding: 'base32',
    //   token,
    //   window
    // });

    // Manual TOTP verification
    const currentTime = Math.floor(Date.now() / 1000 / 30); // 30-second time step

    for (let i = -window; i <= window; i++) {
      const timeSlice = currentTime + i;
      const expectedToken = generateTOTPToken(secret, timeSlice);

      if (token === expectedToken) {
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error('TOTP verification error:', error);
    return false;
  }
};

/**
 * Verify backup code
 * @param {string} code - Backup code from user
 * @param {array} backupCodes - Array of hashed backup codes
 * @returns {object} - { valid, remainingCodes }
 */
const verifyBackupCode = async (code, backupCodes) => {
  const bcrypt = require('bcryptjs');

  if (!code || !backupCodes || backupCodes.length === 0) {
    return { valid: false, remainingCodes: backupCodes };
  }

  for (let i = 0; i < backupCodes.length; i++) {
    const isMatch = await bcrypt.compare(code, backupCodes[i]);

    if (isMatch) {
      // Remove used backup code
      const remaining = [...backupCodes];
      remaining.splice(i, 1);

      return {
        valid: true,
        remainingCodes: remaining
      };
    }
  }

  return { valid: false, remainingCodes: backupCodes };
};

/**
 * Generate QR code data URL for TOTP setup
 * @param {string} otpAuthUrl - otpauth:// URL
 * @returns {Promise<string>} - Base64 data URL for QR code image
 */
const generateQRCode = async (otpAuthUrl) => {
  try {
    // In production, use qrcode library:
    // const QRCode = require('qrcode');
    // return await QRCode.toDataURL(otpAuthUrl);

    // For now, return the URL (frontend can generate QR code)
    return otpAuthUrl;
  } catch (error) {
    console.error('QR code generation error:', error);
    throw new Error('Failed to generate QR code');
  }
};

// ==================== HELPER FUNCTIONS ====================

/**
 * Generate base32 secret (TOTP standard)
 * @returns {string} - Base32 encoded secret
 */
const generateBase32Secret = () => {
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const length = 32;
  let secret = '';

  for (let i = 0; i < length; i++) {
    secret += base32Chars.charAt(Math.floor(Math.random() * base32Chars.length));
  }

  return secret;
};

/**
 * Generate TOTP token for a given time slice
 * @param {string} secret - Base32 encoded secret
 * @param {number} timeSlice - Time slice (epoch / 30)
 * @returns {string} - 6-digit TOTP token
 */
const generateTOTPToken = (secret, timeSlice) => {
  // Simplified TOTP generation (in production, use speakeasy)
  const hmac = crypto.createHmac('sha1', Buffer.from(secret, 'base32'));
  const timeBuffer = Buffer.allocUnsafe(8);
  timeBuffer.writeBigInt64BE(BigInt(timeSlice));

  hmac.update(timeBuffer);
  const hash = hmac.digest();

  const offset = hash[hash.length - 1] & 0x0f;
  const binary = ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  const otp = binary % 1000000;
  return otp.toString().padStart(6, '0');
};

/**
 * Generate backup codes
 * @param {number} count - Number of backup codes to generate
 * @returns {Promise<array>} - Array of hashed backup codes
 */
const generateBackupCodes = async (count = 8) => {
  const bcrypt = require('bcryptjs');
  const codes = [];
  const plainCodes = [];

  for (let i = 0; i < count; i++) {
    // Generate 8-digit backup code
    const code = Math.floor(10000000 + Math.random() * 90000000).toString();
    plainCodes.push(code);

    // Hash the code for storage
    const hashed = await bcrypt.hash(code, 10);
    codes.push(hashed);
  }

  // Return both plain (to show user) and hashed (to store in DB)
  return {
    plain: plainCodes,
    hashed: codes
  };
};

module.exports = {
  generateTOTPSecret,
  verifyTOTP,
  verifyBackupCode,
  generateQRCode,
  generateBackupCodes
};
