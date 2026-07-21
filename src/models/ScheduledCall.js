const { DataTypes } = require('sequelize');
const sequelize = require('../configs/sequelize');

const ScheduledCall = sequelize.define('ScheduledCall', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  customerPhone: {
    type: DataTypes.STRING(20),
    allowNull: false
  },
  customerName: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  accountNumber: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  scheduledAt: {
    type: DataTypes.DATE,
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('pending', 'notified', 'completed', 'cancelled'),
    allowNull: false,
    defaultValue: 'pending'
  },
  managerId: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  managerEmail: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  notifiedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  completedAt: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  tableName: 'scheduled_calls',
  timestamps: true,
  indexes: [
    { fields: ['managerId'] },
    { fields: ['status'] },
    { fields: ['scheduledAt'] }
  ]
});

module.exports = { ScheduledCall };
