const { Manager } = require('./Manager');
const { Customer } = require('./Customer');
const { CallLog } = require('./CallLog');
const { VerificationLog } = require('./VerificationLog');
const { Ticket } = require('./Ticket');
const { AuditLog } = require('./AuditLog');
const { CustomerFeedback } = require('./CustomerFeedback');
const { Admin } = require('./Admin');
const { Recording } = require('./Recording');
const { AuthenticationLog } = require('./AuthenticationLog');
const { TransactionLog } = require('./TransactionLog');
const { AdminActivityLog } = require('./AdminActivityLog');
const { CallAgentReport } = require('./CallAgentReport');
const { ChangeRequest } = require('./ChangeRequest');

// Define associations
CallLog.hasMany(VerificationLog, { foreignKey: 'callLogId', as: 'verifications' });
VerificationLog.belongsTo(CallLog, { foreignKey: 'callLogId', as: 'callLog' });

CallLog.hasMany(Ticket, { foreignKey: 'callLogId', as: 'tickets' });
Ticket.belongsTo(CallLog, { foreignKey: 'callLogId', as: 'callLog' });

CallLog.hasOne(CustomerFeedback, { foreignKey: 'callLogId', as: 'feedback' });
CustomerFeedback.belongsTo(CallLog, { foreignKey: 'callLogId', as: 'callLog' });

CallLog.hasMany(Recording, { foreignKey: 'callLogId', as: 'recordings' });
Recording.belongsTo(CallLog, { foreignKey: 'callLogId', as: 'callLog' });

ChangeRequest.belongsTo(Manager, { foreignKey: 'managerId', as: 'manager' });
Manager.hasMany(ChangeRequest, { foreignKey: 'managerId', as: 'changeRequests' });

// CallAgentReport association is defined in CallAgentReport.js to avoid load-order issues

const sequelize = require('../configs/sequelize');

module.exports = {
  sequelize,
  Manager,
  Customer,
  CallLog,
  VerificationLog,
  Ticket,
  AuditLog,
  CustomerFeedback,
  Admin,
  Recording,
  AuthenticationLog,
  TransactionLog,
  AdminActivityLog,
  CallAgentReport,
  ChangeRequest,
};
