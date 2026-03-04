const { DataTypes } = require("sequelize");
const sequelize = require("../configs/sequelize");

const Manager = sequelize.define(
  "Manager",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    email: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
      validate: {
        isEmail: true,
      },
    },
    password: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    profileImage: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    // Security fields
    failedLoginAttempts: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      allowNull: false
    },
    lockedUntil: {
      type: DataTypes.DATE,
      allowNull: true
    },
    lastFailedLogin: {
      type: DataTypes.DATE,
      allowNull: true
    },
    passwordHistory: {
      type: DataTypes.JSON,
      defaultValue: [],
      allowNull: true,
      comment: 'Array of previous password hashes'
    },
    passwordChangedAt: {
      type: DataTypes.DATE,
      allowNull: true
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    lastLogin: {
      type: DataTypes.DATE,
      allowNull: true
    },
    // TOTP/2FA fields
    totpSecret: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'Encrypted TOTP secret for Google Authenticator'
    },
    totpEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
      comment: 'Whether TOTP 2FA is enabled for this manager'
    },
    totpBackupCodes: {
      type: DataTypes.JSON,
      defaultValue: [],
      allowNull: true,
      comment: 'Array of hashed backup codes for TOTP recovery'
    }
  },
  {
    timestamps: true,
    tableName: "managers",
    indexes: [
      {
        unique: true,
        fields: ["email"],
        name: "managers_email_idx",
      },
    ],
  }
);

module.exports = { Manager };
