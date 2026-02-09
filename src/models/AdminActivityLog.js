/**
 * Admin Activity Log Model
 * Tracks all administrative actions for security and compliance
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../configs/sequelize');

const AdminActivityLog = sequelize.define('AdminActivityLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  activityType: {
    type: DataTypes.ENUM(
      // User Management
      'user_create',
      'user_update',
      'user_delete',
      'user_activate',
      'user_deactivate',
      'user_unlock',
      'user_password_reset',
      'role_assign',
      'role_revoke',
      // Manager Management
      'manager_create',
      'manager_update',
      'manager_delete',
      'manager_status_change',
      'manager_force_logout',
      // Call Management
      'call_monitor',
      'call_whisper',
      'call_barge',
      'call_takeover',
      'call_terminate',
      'recording_start',
      'recording_stop',
      'recording_delete',
      'recording_access',
      // System Configuration
      'settings_update',
      'config_change',
      'feature_toggle',
      // Reports
      'report_generate',
      'report_export',
      'data_export',
      // Security
      'security_alert_resolve',
      'ip_whitelist_update',
      'ip_blacklist_update',
      'audit_log_access',
      'sensitive_data_access',
      // Other
      'bulk_operation',
      'system_maintenance',
      'other'
    ),
    allowNull: false
  },
  // Admin Information
  adminId: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  adminEmail: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  adminName: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  adminRole: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  // Target Information
  targetType: {
    type: DataTypes.ENUM('manager', 'admin', 'customer', 'call', 'recording', 'report', 'settings', 'system'),
    allowNull: true
  },
  targetId: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'ID of the affected entity'
  },
  targetEmail: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  // Action Details
  description: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  previousValue: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'State before the action'
  },
  newValue: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'State after the action'
  },
  // Request Information
  requestPath: {
    type: DataTypes.STRING(500),
    allowNull: true
  },
  requestMethod: {
    type: DataTypes.STRING(10),
    allowNull: true
  },
  requestBody: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Sanitized request body'
  },
  responseStatus: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  // Client Information
  ipAddress: {
    type: DataTypes.STRING(45),
    allowNull: true
  },
  userAgent: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  sessionId: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  // Risk Assessment
  riskLevel: {
    type: DataTypes.ENUM('low', 'medium', 'high', 'critical'),
    defaultValue: 'low'
  },
  requiresReview: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  reviewedBy: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  reviewedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  reviewNotes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // Additional Data
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
  tableName: 'admin_activity_logs',
  timestamps: false,
  indexes: [
    { fields: ['activityType'], name: 'admin_logs_type_idx' },
    { fields: ['adminId'], name: 'admin_logs_admin_id_idx' },
    { fields: ['adminEmail'], name: 'admin_logs_admin_email_idx' },
    { fields: ['targetType'], name: 'admin_logs_target_type_idx' },
    { fields: ['targetId'], name: 'admin_logs_target_id_idx' },
    { fields: ['timestamp'], name: 'admin_logs_timestamp_idx' },
    { fields: ['riskLevel'], name: 'admin_logs_risk_idx' },
    { fields: ['requiresReview'], name: 'admin_logs_review_idx' },
    {
      fields: ['adminEmail', 'activityType', 'timestamp'],
      name: 'admin_logs_admin_activity_time_idx'
    }
  ]
});

/**
 * Determine risk level based on activity type
 */
AdminActivityLog.getRiskLevel = (activityType) => {
  const criticalActivities = [
    'user_delete', 'manager_delete', 'recording_delete',
    'security_alert_resolve', 'ip_blacklist_update', 'bulk_operation'
  ];

  const highRiskActivities = [
    'user_create', 'role_assign', 'role_revoke', 'user_password_reset',
    'call_takeover', 'call_terminate', 'settings_update', 'config_change',
    'data_export', 'sensitive_data_access'
  ];

  const mediumRiskActivities = [
    'user_update', 'user_deactivate', 'user_unlock', 'manager_update',
    'manager_force_logout', 'recording_access', 'report_export',
    'call_barge', 'call_whisper'
  ];

  if (criticalActivities.includes(activityType)) return 'critical';
  if (highRiskActivities.includes(activityType)) return 'high';
  if (mediumRiskActivities.includes(activityType)) return 'medium';
  return 'low';
};

module.exports = { AdminActivityLog };
