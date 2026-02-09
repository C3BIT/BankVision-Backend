const { DataTypes } = require('sequelize');
const sequelize = require('../configs/sequelize');

const AuditLog = sequelize.define('AuditLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  action: {
    type: DataTypes.ENUM(
      'login',
      'logout',
      'call_initiated',
      'call_accepted',
      'call_rejected',
      'call_ended',
      'call_cancelled',
      'verification_requested',
      'verification_completed',
      'phone_change',
      'email_change',
      'address_change',
      'account_activation',
      'nid_verification',
      'face_verification',
      'ticket_created',
      'ticket_updated',
      'ticket_resolved',
      'status_change',
      'data_export',
      'settings_change',
      'other'
    ),
    allowNull: false
  },
  entityType: {
    type: DataTypes.ENUM('customer', 'manager', 'call', 'ticket', 'verification', 'system'),
    allowNull: false
  },
  entityId: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'ID of the affected entity'
  },
  performedBy: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'User who performed the action (email or phone)'
  },
  performedByRole: {
    type: DataTypes.ENUM('customer', 'manager', 'admin', 'system'),
    allowNull: true
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
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  ipAddress: {
    type: DataTypes.STRING(45),
    allowNull: true
  },
  userAgent: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  sessionId: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  metadata: {
    type: DataTypes.JSON,
    allowNull: true
  },
  timestamp: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'audit_logs',
  timestamps: false,
  indexes: [
    { fields: ['action'] },
    { fields: ['entityType'] },
    { fields: ['entityId'] },
    { fields: ['performedBy'] },
    { fields: ['timestamp'] },
    { fields: ['performedByRole'] }
  ]
});

module.exports = { AuditLog };
