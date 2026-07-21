const { DataTypes } = require("sequelize");
const sequelize = require("../configs/sequelize");

/**
 * Historical record of manager presence/status changes (online, busy, break,
 * lunch, prayer, not_ready, offline) — powers VBRM activity/performance
 * reports in the Admin Portal. The live status itself lives in Redis/cache
 * (see cacheService.js); this table is the durable timeline of changes.
 */
const ManagerStatusLog = sequelize.define(
  "ManagerStatusLog",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    managerEmail: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    managerName: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM("online", "busy", "break", "lunch", "prayer", "not_ready", "offline"),
      allowNull: false,
    },
    previousStatus: {
      type: DataTypes.ENUM("online", "busy", "break", "lunch", "prayer", "not_ready", "offline"),
      allowNull: true,
    },
  },
  {
    tableName: "manager_status_logs",
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ["managerEmail"] },
      { fields: ["status"] },
      { fields: ["createdAt"] },
      { fields: ["managerEmail", "createdAt"] },
    ],
  }
);

module.exports = { ManagerStatusLog };
