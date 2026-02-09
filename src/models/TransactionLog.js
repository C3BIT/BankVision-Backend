/**
 * Transaction Log Model
 * Tracks all banking/service transactions for compliance and auditing
 */
const { DataTypes } = require('sequelize');
const sequelize = require('../configs/sequelize');

const TransactionLog = sequelize.define('TransactionLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  transactionType: {
    type: DataTypes.ENUM(
      'phone_change',
      'email_change',
      'address_change',
      'account_activation',
      'account_reactivation',
      'nid_verification',
      'face_verification',
      'phone_verification',
      'email_verification',
      'cheque_book_request',
      'card_request',
      'statement_request',
      'balance_inquiry',
      'fund_transfer',
      'bill_payment',
      'other_service'
    ),
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM(
      'initiated',
      'pending_verification',
      'processing',
      'completed',
      'failed',
      'cancelled',
      'expired',
      'reversed'
    ),
    defaultValue: 'initiated',
    allowNull: false
  },
  // Customer Information
  customerPhone: {
    type: DataTypes.STRING(20),
    allowNull: false
  },
  customerName: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  customerAccountNumber: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  // Manager Information
  managerId: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  managerEmail: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  managerName: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  // Call Reference
  callLogId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  referenceNumber: {
    type: DataTypes.STRING(50),
    allowNull: true,
    unique: true,
    comment: 'Unique transaction reference number'
  },
  // Transaction Details
  previousValue: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Value before transaction'
  },
  newValue: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Value after transaction'
  },
  requestData: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Original request data (sanitized)'
  },
  responseData: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'CBS/API response data'
  },
  // Verification
  verificationMethod: {
    type: DataTypes.ENUM('phone_otp', 'email_otp', 'face_match', 'nid_match', 'manual', 'none'),
    allowNull: true
  },
  verificationStatus: {
    type: DataTypes.BOOLEAN,
    allowNull: true
  },
  verificationAttempts: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  // Error Tracking
  errorCode: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  errorMessage: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  // Audit Trail
  ipAddress: {
    type: DataTypes.STRING(45),
    allowNull: true
  },
  userAgent: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  channel: {
    type: DataTypes.ENUM('video_call', 'web', 'mobile_app', 'api'),
    defaultValue: 'video_call'
  },
  // Timestamps
  initiatedAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  completedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  // Additional metadata
  metadata: {
    type: DataTypes.JSON,
    allowNull: true
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Manager notes about the transaction'
  },
  // Compliance
  approvedBy: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'For maker-checker workflow'
  },
  approvedAt: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'transaction_logs',
  timestamps: true,
  indexes: [
    { fields: ['transactionType'], name: 'txn_logs_type_idx' },
    { fields: ['status'], name: 'txn_logs_status_idx' },
    { fields: ['customerPhone'], name: 'txn_logs_customer_phone_idx' },
    { fields: ['customerAccountNumber'], name: 'txn_logs_account_idx' },
    { fields: ['managerEmail'], name: 'txn_logs_manager_idx' },
    { fields: ['callLogId'], name: 'txn_logs_call_idx' },
    { fields: ['referenceNumber'], name: 'txn_logs_ref_idx' },
    { fields: ['initiatedAt'], name: 'txn_logs_initiated_idx' },
    { fields: ['completedAt'], name: 'txn_logs_completed_idx' },
    {
      fields: ['customerPhone', 'transactionType', 'initiatedAt'],
      name: 'txn_logs_customer_type_time_idx'
    }
  ]
});

/**
 * Generate unique transaction reference number
 */
TransactionLog.generateReference = () => {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `TXN-${dateStr}-${random}`;
};

module.exports = { TransactionLog };
