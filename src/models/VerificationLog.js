const { DataTypes } = require('sequelize');
const sequelize = require('../configs/sequelize');

const VerificationLog = sequelize.define('VerificationLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  callLogId: {
    type: DataTypes.UUID,
    allowNull: true,
    comment: 'Reference to the call log'
  },
  customerPhone: {
    type: DataTypes.STRING(20),
    allowNull: false
  },
  accountNumber: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  verificationType: {
    type: DataTypes.ENUM('phone', 'email', 'face', 'nid', 'otp'),
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('pending', 'verified', 'failed', 'expired'),
    defaultValue: 'pending'
  },
  requestedBy: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Manager email who requested verification'
  },
  verificationData: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Additional verification metadata'
  },
  requestedAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  verifiedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  attempts: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  ipAddress: {
    type: DataTypes.STRING(45),
    allowNull: true
  },
  userAgent: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'verification_logs',
  timestamps: true,
  indexes: [
    { fields: ['customerPhone'] },
    { fields: ['accountNumber'] },
    { fields: ['verificationType'] },
    { fields: ['status'] },
    { fields: ['requestedAt'] }
  ]
});

module.exports = { VerificationLog };
