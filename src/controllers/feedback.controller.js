const { CustomerFeedback, CallLog } = require('../models');

/**
 * Submit customer feedback
 * POST /api/feedback
 */
const submitFeedback = async (req, res) => {
  try {
    const {
      callLogId,
      referenceNumber,
      customerPhone,
      managerEmail,
      rating,
      feedbackText,
      callDuration,
      categories,
      wouldRecommend,
      issueResolved
    } = req.body;

    if (!customerPhone || !rating) {
      return res.status(400).json({
        success: false,
        message: 'Customer phone and rating are required'
      });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'Rating must be between 1 and 5'
      });
    }

    const feedback = await CustomerFeedback.create({
      callLogId,
      referenceNumber,
      customerPhone,
      managerEmail,
      rating,
      feedbackText,
      callDuration,
      categories,
      wouldRecommend,
      issueResolved
    });

    console.log(`✅ Feedback submitted: Rating ${rating}/5 for manager ${managerEmail || 'unknown'}`);

    // Emit stats update event to refresh manager dashboards
    const io = req.app.get('io');
    if (io) {
      io.emit('stats:update', {
        event: 'feedback-submitted',
        timestamp: Date.now(),
        managerEmail,
        rating
      });
      console.log(`📊 Emitted stats:update event after feedback submission`);
    }

    res.status(201).json({
      success: true,
      message: 'Feedback submitted successfully',
      data: {
        id: feedback.id,
        referenceNumber: feedback.referenceNumber
      }
    });
  } catch (error) {
    console.error('Submit Feedback Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to submit feedback'
    });
  }
};

/**
 * Get feedback statistics
 * GET /api/feedback/statistics
 */
const getFeedbackStatistics = async (req, res) => {
  try {
    const { startDate, endDate, managerEmail } = req.query;

    const where = {};
    if (startDate && endDate) {
      where.createdAt = {
        [require('sequelize').Op.between]: [new Date(startDate), new Date(endDate)]
      };
    }
    if (managerEmail) {
      where.managerEmail = managerEmail;
    }

    const feedbacks = await CustomerFeedback.findAll({ where });

    // Calculate statistics
    const totalFeedbacks = feedbacks.length;
    const totalRating = feedbacks.reduce((sum, f) => sum + f.rating, 0);
    const averageRating = totalFeedbacks > 0 ? (totalRating / totalFeedbacks).toFixed(2) : 0;

    // Rating distribution
    const ratingDistribution = {
      1: 0, 2: 0, 3: 0, 4: 0, 5: 0
    };
    feedbacks.forEach(f => {
      ratingDistribution[f.rating]++;
    });

    // Satisfaction rate (4 or 5 stars)
    const satisfiedCount = feedbacks.filter(f => f.rating >= 4).length;
    const satisfactionRate = totalFeedbacks > 0
      ? ((satisfiedCount / totalFeedbacks) * 100).toFixed(1)
      : 0;

    res.json({
      success: true,
      data: {
        totalFeedbacks,
        averageRating: parseFloat(averageRating),
        satisfactionRate: parseFloat(satisfactionRate),
        ratingDistribution,
        issuesResolvedRate: totalFeedbacks > 0
          ? ((feedbacks.filter(f => f.issueResolved).length / totalFeedbacks) * 100).toFixed(1)
          : 0
      }
    });
  } catch (error) {
    console.error('Get Feedback Statistics Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get feedback statistics'
    });
  }
};

/**
 * Get feedback list
 * GET /api/feedback
 */
const getFeedbackList = async (req, res) => {
  try {
    const { page = 1, limit = 20, managerEmail, minRating, maxRating } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (managerEmail) where.managerEmail = managerEmail;
    if (minRating) where.rating = { [require('sequelize').Op.gte]: parseInt(minRating) };
    if (maxRating) {
      where.rating = where.rating || {};
      where.rating[require('sequelize').Op.lte] = parseInt(maxRating);
    }

    const { count, rows } = await CustomerFeedback.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    res.json({
      success: true,
      data: {
        feedbacks: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Get Feedback List Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get feedback list'
    });
  }
};

module.exports = {
  submitFeedback,
  getFeedbackStatistics,
  getFeedbackList
};
