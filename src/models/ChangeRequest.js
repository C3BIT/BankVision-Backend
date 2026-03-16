const { DataTypes } = require('sequelize');
const sequelize = require('../configs/sequelize');

const ChangeRequest = sequelize.define('ChangeRequest', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  customerId: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'Customer phone number or ID',
  },
  managerId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: 'Manager who approved/rejected the request',
  },
  changeType: {
    type: DataTypes.ENUM('phone', 'email', 'address'),
    allowNull: false,
    comment: 'Type of change requested',
  },
  oldValue: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Previous value before change (JSON for address)',
  },
  newValue: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: 'New value after change (JSON for address)',
  },
  status: {
    type: DataTypes.ENUM('pending', 'approved', 'rejected'),
    defaultValue: 'pending',
    comment: 'Status of the change request',
  },
  rejectionReason: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Reason for rejection if rejected',
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Additional notes, e.g. manager override details',
  },
  method: {
    type: DataTypes.ENUM('standard', 'manager_override'),
    defaultValue: 'standard',
    allowNull: false,
    comment: 'How the change was processed: standard approval dialog, or manager OTP override',
  },
  ipAddress: {
    type: DataTypes.STRING(45),
    allowNull: true,
    comment: 'IP address of the customer',
  },
  userAgent: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'User agent of the customer browser',
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'change_requests',
  timestamps: true,
  indexes: [
    {
      fields: ['customerId'],
      name: 'idx_customer',
    },
    {
      fields: ['managerId'],
      name: 'idx_manager',
    },
    {
      fields: ['status'],
      name: 'idx_status',
    },
    {
      fields: ['createdAt'],
      name: 'idx_created',
    },
    {
      fields: ['changeType'],
      name: 'idx_change_type',
    },
  ],
});

module.exports = { ChangeRequest };
