/**
 * Refresh Token Service - Manage JWT refresh tokens
 * Implements short-lived access tokens (15min) + long-lived refresh tokens (30 days)
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { RefreshToken } = require('../models/RefreshToken');
const { Op } = require('sequelize');

// Token expiration times
const ACCESS_TOKEN_EXPIRY = '15m'; // 15 minutes
const REFRESH_TOKEN_EXPIRY_DAYS = 30; // 30 days
const REFRESH_TOKEN_EXPIRY_MS = REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

/**
 * Generate a new refresh token
 * @param {number} userId - User ID
 * @param {string} userType - User type ('manager', 'admin', 'customer')
 * @param {object} metadata - { ipAddress, userAgent, deviceId }
 * @returns {Promise<string>} - Plain refresh token (to send to client)
 */
const generateRefreshToken = async (userId, userType, metadata = {}) => {
  try {
    // Generate cryptographically secure random token
    const plainToken = crypto.randomBytes(40).toString('hex');

    // Hash token before storing (like passwords)
    const hashedToken = await bcrypt.hash(plainToken, 10);

    // Calculate expiration date
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);

    // Store in database
    await RefreshToken.create({
      token: hashedToken,
      userId,
      userType,
      expiresAt,
      ipAddress: metadata.ipAddress || null,
      userAgent: metadata.userAgent || null,
      deviceId: metadata.deviceId || null
    });

    // Return plain token (client will send this in refresh requests)
    return plainToken;
  } catch (error) {
    console.error('Refresh token generation error:', error);
    throw new Error('Failed to generate refresh token');
  }
};

/**
 * Verify and use a refresh token
 * @param {string} plainToken - Plain refresh token from client
 * @param {number} userId - User ID (for validation)
 * @param {string} userType - User type (for validation)
 * @returns {Promise<object|null>} - Token record if valid, null otherwise
 */
const verifyRefreshToken = async (plainToken, userId, userType) => {
  try {
    if (!plainToken || !userId || !userType) {
      return null;
    }

    // Find all non-revoked, non-expired tokens for this user
    const tokens = await RefreshToken.findAll({
      where: {
        userId,
        userType,
        isRevoked: false,
        expiresAt: { [Op.gt]: new Date() }
      }
    });

    // Check each token hash to find a match
    for (const tokenRecord of tokens) {
      const isMatch = await bcrypt.compare(plainToken, tokenRecord.token);

      if (isMatch) {
        // Update last used timestamp
        tokenRecord.lastUsedAt = new Date();
        await tokenRecord.save();

        return tokenRecord;
      }
    }

    return null;
  } catch (error) {
    console.error('Refresh token verification error:', error);
    return null;
  }
};

/**
 * Revoke a refresh token (logout)
 * @param {string} plainToken - Plain refresh token to revoke
 * @param {number} userId - User ID
 * @param {string} userType - User type
 * @returns {Promise<boolean>} - True if revoked successfully
 */
const revokeRefreshToken = async (plainToken, userId, userType) => {
  try {
    const tokens = await RefreshToken.findAll({
      where: {
        userId,
        userType,
        isRevoked: false
      }
    });

    for (const tokenRecord of tokens) {
      const isMatch = await bcrypt.compare(plainToken, tokenRecord.token);

      if (isMatch) {
        tokenRecord.isRevoked = true;
        await tokenRecord.save();
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error('Refresh token revocation error:', error);
    return false;
  }
};

/**
 * Revoke all refresh tokens for a user (logout all devices)
 * @param {number} userId - User ID
 * @param {string} userType - User type
 * @returns {Promise<number>} - Number of tokens revoked
 */
const revokeAllRefreshTokens = async (userId, userType) => {
  try {
    const result = await RefreshToken.update(
      { isRevoked: true },
      {
        where: {
          userId,
          userType,
          isRevoked: false
        }
      }
    );

    return result[0]; // Number of rows updated
  } catch (error) {
    console.error('Revoke all tokens error:', error);
    return 0;
  }
};

/**
 * Clean up expired refresh tokens (run periodically via cron)
 * @returns {Promise<number>} - Number of tokens deleted
 */
const cleanupExpiredTokens = async () => {
  try {
    const result = await RefreshToken.destroy({
      where: {
        [Op.or]: [
          { expiresAt: { [Op.lt]: new Date() } },
          { isRevoked: true }
        ]
      }
    });

    console.log(`🗑️ Cleaned up ${result} expired/revoked refresh tokens`);
    return result;
  } catch (error) {
    console.error('Token cleanup error:', error);
    return 0;
  }
};

/**
 * Get all active refresh tokens for a user (for device management)
 * @param {number} userId - User ID
 * @param {string} userType - User type
 * @returns {Promise<array>} - Array of active tokens with metadata
 */
const getUserActiveTokens = async (userId, userType) => {
  try {
    const tokens = await RefreshToken.findAll({
      where: {
        userId,
        userType,
        isRevoked: false,
        expiresAt: { [Op.gt]: new Date() }
      },
      attributes: ['id', 'createdAt', 'expiresAt', 'lastUsedAt', 'ipAddress', 'userAgent', 'deviceId'],
      order: [['createdAt', 'DESC']]
    });

    return tokens;
  } catch (error) {
    console.error('Get active tokens error:', error);
    return [];
  }
};

module.exports = {
  generateRefreshToken,
  verifyRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  cleanupExpiredTokens,
  getUserActiveTokens,
  ACCESS_TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY_DAYS
};
