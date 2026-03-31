const { DataTypes } = require('sequelize');
const sequelize = require('../configs/sequelize');

const Admin = sequelize.define('Admin', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  email: {
    type: DataTypes.STRING(100),
    allowNull: false,
    unique: true,
    validate: {
      isEmail: true
    }
  },
  password: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  role: {
    type: DataTypes.ENUM('super_admin', 'supervisor', 'admin'),
    defaultValue: 'admin',
    allowNull: false
  },
  // Security fields for brute force protection
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
    comment: 'Array of previous password hashes (last 5)'
  },
  passwordChangedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  },
  lastLogin: {
    type: DataTypes.DATE,
    allowNull: true
  },
  profileImage: {
    type: DataTypes.STRING(500),
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
    comment: 'Whether TOTP 2FA is enabled for this admin'
  },
  totpBackupCodes: {
    type: DataTypes.JSON,
    defaultValue: [],
    allowNull: true,
    comment: 'Array of hashed backup codes for TOTP recovery'
  }
}, {
  tableName: 'admins',
  timestamps: true,
  hooks: {
    beforeCreate: (admin) => {
      admin.passwordChangedAt = new Date();
    },
    beforeUpdate: (admin) => {
      if (admin.changed('password')) {
        admin.passwordChangedAt = new Date();
      }
    }
  }
});

module.exports = { Admin };
