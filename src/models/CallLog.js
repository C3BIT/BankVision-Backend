const { DataTypes } = require("sequelize");
const sequelize = require("../configs/sequelize");

const CallLog = sequelize.define(
  "CallLog",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    referenceNumber: {
      type: DataTypes.STRING(20),
      allowNull: true,
      unique: true,
      comment: "Unique reference number for customer tracking",
    },
    callRoom: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    customerPhone: {
      type: DataTypes.STRING(15),
      allowNull: false,
    },
    customerEmail: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: "Customer email for post-call summary",
    },
    customerName: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    customerAccountNumber: {
      type: DataTypes.STRING(15),
      allowNull: true,
    },
    managerEmail: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    managerName: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    startTime: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    endTime: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    duration: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "Duration in seconds",
    },
    status: {
      type: DataTypes.ENUM("initiated", "accepted", "completed", "missed", "cancelled", "failed"),
      defaultValue: "initiated",
    },
    endedBy: {
      type: DataTypes.ENUM("customer", "manager", "system"),
      allowNull: true,
    },
    queueWaitTime: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "Queue wait time in seconds",
    },
    phoneVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    emailVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    faceVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    chatMessagesCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: "Additional call data like verification details, etc.",
    },
    summaryEmailSent: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: "Whether post-call summary email was sent",
    },
    summaryEmailSentAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    timestamps: true,
    tableName: "call_logs",
    indexes: [
      {
        fields: ["customerPhone"],
        name: "call_logs_customer_phone_idx",
      },
      {
        fields: ["managerEmail"],
        name: "call_logs_manager_email_idx",
      },
      {
        fields: ["startTime"],
        name: "call_logs_start_time_idx",
      },
      {
        fields: ["status"],
        name: "call_logs_status_idx",
      },
      {
        fields: ["referenceNumber"],
        name: "call_logs_reference_number_idx",
      },
    ],
  }
);

module.exports = { CallLog };
