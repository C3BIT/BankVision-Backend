const { DataTypes } = require("sequelize");
const sequelize = require("../configs/sequelize");

/**
 * Post-call agent report: type of service provided (multi-select) + remarks for CRM/audit.
 * Used for CRM updates, lead generation, and downstream workflows.
 */
const CallAgentReport = sequelize.define(
  "CallAgentReport",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    callLogId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "call_logs", key: "id" },
      onDelete: "CASCADE",
      comment: "Reference to the completed call",
    },
    managerEmail: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    managerName: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    referenceNumber: {
      type: DataTypes.STRING(20),
      allowNull: true,
      comment: "Call reference number for audit",
    },
    serviceTypes: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
      comment: "Multi-select: e.g. kyc_verification, phone_change, email_change, address_change, dormant_activation, general_inquiry, complaint, document_request, other",
    },
    remarks: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: "Notes for CRM and audit",
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: "Additional data for downstream workflows",
    },
  },
  {
    timestamps: true,
    tableName: "call_agent_reports",
    indexes: [
      { fields: ["callLogId"], unique: true },
      { fields: ["managerEmail"] },
      { fields: ["createdAt"] },
    ],
  }
);

// Define association using already-registered CallLog (avoids load-order / circular require)
const CallLog = sequelize.models.CallLog;
if (CallLog) {
  CallAgentReport.belongsTo(CallLog, { foreignKey: "callLogId", as: "callLog" });
  CallLog.hasOne(CallAgentReport, { foreignKey: "callLogId", as: "agentReport" });
}

module.exports = CallAgentReport;
