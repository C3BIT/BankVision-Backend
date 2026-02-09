/**
 * RefreshToken Model - Store refresh tokens for JWT token refresh mechanism
 * Enables short-lived access tokens (15min) with long-lived refresh tokens (30 days)
 */

const { DataTypes } = require('sequelize');
const sequelize = require('../configs/sequelize');

const RefreshToken = sequelize.define('RefreshToken', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  token: {
    type: DataTypes.STRING(500),
    allowNull: false,
    unique: true,
    comment: 'Hashed refresh token'
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: 'User ID (manager or admin)'
  },
  userType: {
    type: DataTypes.ENUM('manager', 'admin', 'customer'),
    allowNull: false,
    comment: 'Type of user this token belongs to'
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false,
    comment: 'Expiration date of refresh token (30 days from creation)'
  },
  isRevoked: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
    comment: 'Whether this token has been revoked (logout or security event)'
  },
  ipAddress: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'IP address where token was created'
  },
  userAgent: {
    type: DataTypes.STRING(500),
    allowNull: true,
    comment: 'User agent string for device tracking'
  },
  deviceId: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Unique device identifier for multi-device support'
  },
  lastUsedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Last time this refresh token was used'
  }
}, {
  tableName: 'refresh_tokens',
  timestamps: true,
  indexes: [
    {
      unique: true,
      fields: ['token'],
      name: 'refresh_token_idx'
    },
    {
      fields: ['userId', 'userType'],
      name: 'user_refresh_tokens_idx'
    },
    {
      fields: ['expiresAt'],
      name: 'token_expiry_idx'
    }
  ]
});

module.exports = { RefreshToken };
