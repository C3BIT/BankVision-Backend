const { DataTypes } = require('sequelize');
const sequelize = require('../configs/sequelize');

const Recording = sequelize.define('Recording', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  callLogId: {
    type: DataTypes.UUID,
    allowNull: true,
    comment: 'Reference to call log'
  },
  callRoom: {
    type: DataTypes.STRING(255),
    allowNull: false,
    comment: 'Jitsi room URL/ID'
  },
  customerPhone: {
    type: DataTypes.STRING(20),
    allowNull: false
  },
  managerEmail: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('recording', 'processing', 'completed', 'failed', 'deleted'),
    defaultValue: 'recording'
  },
  startTime: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  },
  endTime: {
    type: DataTypes.DATE,
    allowNull: true
  },
  duration: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Duration in seconds'
  },
  filePath: {
    type: DataTypes.STRING(500),
    allowNull: true
  },
  fileSize: {
    type: DataTypes.BIGINT,
    allowNull: true,
    comment: 'File size in bytes'
  },
  fileFormat: {
    type: DataTypes.STRING(20),
    allowNull: true,
    defaultValue: 'mp4'
  },
  thumbnailPath: {
    type: DataTypes.STRING(500),
    allowNull: true
  },
  metadata: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Additional recording metadata'
  },
  recordedBy: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'Who initiated the recording'
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  egressId: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: 'LiveKit Egress job ID'
  },
  storageUrl: {
    type: DataTypes.STRING(500),
    allowNull: true,
    comment: 'MinIO/S3 storage URL'
  }
}, {
  tableName: 'recordings',
  timestamps: true,
  indexes: [
    { fields: ['callLogId'] },
    { fields: ['callRoom'] },
    { fields: ['customerPhone'] },
    { fields: ['managerEmail'] },
    { fields: ['status'] },
    { fields: ['startTime'] }
  ]
});

module.exports = { Recording };
