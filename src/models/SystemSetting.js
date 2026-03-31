const { DataTypes } = require('sequelize');
const sequelize = require('../configs/sequelize');

const SystemSetting = sequelize.define('SystemSetting', {
  key: {
    type: DataTypes.STRING(100),
    primaryKey: true,
    allowNull: false
  },
  value: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  description: {
    type: DataTypes.STRING(255),
    allowNull: true
  }
}, {
  tableName: 'system_settings',
  timestamps: true
});

// Helper to get a setting value with a default
SystemSetting.getValue = async (key, defaultValue = null) => {
  const setting = await SystemSetting.findByPk(key);
  return setting ? setting.value : defaultValue;
};

// Helper to set a setting value
SystemSetting.setValue = async (key, value, description = null) => {
  const [setting] = await SystemSetting.upsert({
    key,
    value: String(value),
    ...(description && { description })
  });
  return setting;
};

module.exports = { SystemSetting };
