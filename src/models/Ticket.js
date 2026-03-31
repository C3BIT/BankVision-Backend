const { DataTypes } = require('sequelize');
const sequelize = require('../configs/sequelize');

const Ticket = sequelize.define('Ticket', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  ticketNumber: {
    type: DataTypes.STRING(20),
    unique: true,
    allowNull: false
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
  customerName: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  accountNumber: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  category: {
    type: DataTypes.ENUM(
      'account_inquiry',
      'phone_change',
      'email_change',
      'address_change',
      'account_activation',
      'complaint',
      'feedback',
      'other'
    ),
    defaultValue: 'other'
  },
  priority: {
    type: DataTypes.ENUM('low', 'medium', 'high', 'urgent'),
    defaultValue: 'medium'
  },
  status: {
    type: DataTypes.ENUM('open', 'in_progress', 'resolved', 'closed', 'escalated'),
    defaultValue: 'open'
  },
  subject: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  resolution: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  assignedTo: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Manager email assigned to this ticket'
  },
  createdBy: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Manager email who created the ticket'
  },
  resolvedBy: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  resolvedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  escalatedTo: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  escalatedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  metadata: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Additional ticket metadata'
  }
}, {
  tableName: 'tickets',
  timestamps: true,
  indexes: [
    { fields: ['ticketNumber'], unique: true },
    { fields: ['customerPhone'] },
    { fields: ['accountNumber'] },
    { fields: ['status'] },
    { fields: ['category'] },
    { fields: ['priority'] },
    { fields: ['assignedTo'] },
    { fields: ['createdAt'] }
  ],
  hooks: {
    beforeCreate: (ticket) => {
      if (!ticket.ticketNumber) {
        const timestamp = Date.now().toString(36).toUpperCase();
        const random = Math.random().toString(36).substring(2, 6).toUpperCase();
        ticket.ticketNumber = `TKT${timestamp}${random}`;
      }
    }
  }
});

module.exports = { Ticket };
