const { DataTypes } = require('sequelize');
const sequelize = require('../configs/sequelize');

const CustomerFeedback = sequelize.define('CustomerFeedback', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  callLogId: {
    type: DataTypes.UUID,
    allowNull: true,
    comment: 'Reference to the call log'
  },
  referenceNumber: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'Call reference number shown to customer'
  },
  customerPhone: {
    type: DataTypes.STRING(20),
    allowNull: false
  },
  managerEmail: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  rating: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: {
      min: 1,
      max: 5
    },
    comment: 'Customer satisfaction rating 1-5'
  },
  ratingLabel: {
    type: DataTypes.ENUM(
      'very_dissatisfied',
      'dissatisfied',
      'neutral',
      'satisfied',
      'very_satisfied'
    ),
    allowNull: true
  },
  feedbackText: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Optional feedback comment'
  },
  callDuration: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Call duration in seconds'
  },
  categories: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Feedback categories selected'
  },
  wouldRecommend: {
    type: DataTypes.BOOLEAN,
    allowNull: true
  },
  issueResolved: {
    type: DataTypes.BOOLEAN,
    allowNull: true
  },
  metadata: {
    type: DataTypes.JSON,
    allowNull: true
  }
}, {
  tableName: 'customer_feedback',
  timestamps: true,
  indexes: [
    { fields: ['customerPhone'] },
    { fields: ['managerEmail'] },
    { fields: ['rating'] },
    { fields: ['createdAt'] }
  ],
  hooks: {
    beforeCreate: (feedback) => {
      // Set rating label based on rating value
      const labels = {
        1: 'very_dissatisfied',
        2: 'dissatisfied',
        3: 'neutral',
        4: 'satisfied',
        5: 'very_satisfied'
      };
      feedback.ratingLabel = labels[feedback.rating] || 'neutral';
    }
  }
});

module.exports = { CustomerFeedback };
