const { DataTypes } = require("sequelize");
const sequelize = require("../configs/sequelize");

const Customer = sequelize.define(
  "Customer",
  {
    accountNumber: {
      type: DataTypes.STRING(15),
      unique: true,
      allowNull: false,
      primaryKey: true,
    },
    mobileNumber: {
      type: DataTypes.STRING(15),
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(100),
      allowNull: false,
      validate: {
        isEmail: true,
      },
    },
    name: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    address: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    branch: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    profileImage: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    // Password authentication fields (optional - customers can use OTP or password)
    password: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'Hashed password for password-based login (optional, can use OTP instead)'
    },
    passwordChangedAt: {
      type: DataTypes.DATE,
      allowNull: true
    },
    passwordHistory: {
      type: DataTypes.JSON,
      defaultValue: [],
      allowNull: true,
      comment: 'Array of previous password hashes'
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
    lastLogin: {
      type: DataTypes.DATE,
      allowNull: true
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      allowNull: false
    }
  },
  {
    tableName: "customers",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["accountNumber"],
        name: "accountNumber_icx",
      },
    ],
  }
);

module.exports = { Customer };
