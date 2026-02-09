/**
 * Authentication Log Model
 * Tracks all authentication events for security auditing
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../configs/sequelize');

const AuthenticationLog = sequelize.define('AuthenticationLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  eventType: {
    type: DataTypes.ENUM(
      'login_success',
      'login_failed',
      'logout',
      'token_refresh',
      'password_reset_request',
      'password_reset_success',
      'password_change',
      'account_locked',
      'account_unlocked',
      'session_expired',
      'session_invalidated',
      'force_logout',
      '2fa_requested',
      '2fa_success',
      '2fa_failed'
    ),
    allowNull: false
  },
  userType: {
    type: DataTypes.ENUM('customer', 'manager', 'admin'),
    allowNull: false
  },
  userId: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'User ID (manager id, admin id, or customer phone)'
  },
  userEmail: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  userPhone: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  ipAddress: {
    type: DataTypes.STRING(45),
    allowNull: true,
    comment: 'IPv4 or IPv6 address'
  },
  userAgent: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  deviceInfo: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Parsed device/browser info'
  },
  location: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Geo-location if available'
  },
  sessionId: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  failureReason: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Reason for failure (invalid password, account locked, etc.)'
  },
  failedAttempts: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Number of failed attempts at this point'
  },
  riskScore: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Risk score 0-100 based on various factors'
  },
  riskFactors: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Array of risk factors detected'
  },
  metadata: {
    type: DataTypes.JSON,
    allowNull: true
  },
  timestamp: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
    allowNull: false
  }
}, {
  tableName: 'authentication_logs',
  timestamps: false,
  indexes: [
    { fields: ['eventType'], name: 'auth_logs_event_type_idx' },
    { fields: ['userType'], name: 'auth_logs_user_type_idx' },
    { fields: ['userId'], name: 'auth_logs_user_id_idx' },
    { fields: ['userEmail'], name: 'auth_logs_email_idx' },
    { fields: ['ipAddress'], name: 'auth_logs_ip_idx' },
    { fields: ['timestamp'], name: 'auth_logs_timestamp_idx' },
    { fields: ['sessionId'], name: 'auth_logs_session_idx' },
    {
      fields: ['userEmail', 'eventType', 'timestamp'],
      name: 'auth_logs_user_event_time_idx'
    }
  ]
});

module.exports = { AuthenticationLog };
