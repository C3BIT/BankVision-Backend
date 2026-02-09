const { CallLog } = require("../models/CallLog");
const { CustomerFeedback } = require("../models/CustomerFeedback");
const { Op } = require("sequelize");
const { generateReferenceNumber, sendPostCallSummaryEmail, sendCallReferenceEmail } = require("./emailService");

/**
 * Create a new call log entry when call is initiated
 */
const createCallLog = async (callData) => {
  try {
    const referenceNumber = generateReferenceNumber();

    const callLog = await CallLog.create({
      callRoom: callData.callRoom,
      referenceNumber,
      customerPhone: callData.customerPhone,
      customerEmail: callData.customerEmail || null,
      customerName: callData.customerName || null,
      customerAccountNumber: callData.customerAccountNumber || null,
      managerEmail: callData.managerEmail,
      managerName: callData.managerName || null,
      startTime: new Date(),
      status: "initiated",
      queueWaitTime: callData.queueWaitTime || null,
      metadata: callData.metadata || null,
    });

    console.log(`Call log created: ${callLog.id} | Ref: ${referenceNumber}`);

    // Send reference number email to customer if email provided
    if (callData.customerEmail) {
      sendCallReferenceEmail({
        customerEmail: callData.customerEmail,
        customerName: callData.customerName,
        referenceNumber,
        managerName: callData.managerName
      }).catch(err => console.error('Failed to send reference email:', err));
    }

    return callLog;
  } catch (error) {
    console.error("Error creating call log:", error);
    throw error;
  }
};

/**
 * Update call log status to accepted
 */
const acceptCall = async (callRoom) => {
  try {
    const callLog = await CallLog.findOne({
      where: { callRoom, status: "initiated" },
    });

    if (callLog) {
      await callLog.update({ status: "accepted" });
      console.log(`📝 Call log updated to accepted: ${callLog.id}`);
    }

    return callLog;
  } catch (error) {
    console.error("❌ Error updating call log to accepted:", error);
    throw error;
  }
};

/**
 * Complete a call and calculate duration
 */
const completeCall = async (callRoom, endedBy = "system", additionalData = {}) => {
  try {
    const callLog = await CallLog.findOne({
      where: {
        callRoom,
        status: { [Op.in]: ["initiated", "accepted"] },
      },
    });

    if (callLog) {
      const endTime = new Date();
      const duration = Math.floor((endTime - callLog.startTime) / 1000);

      await callLog.update({
        status: "completed",
        endTime,
        duration,
        endedBy,
        phoneVerified: additionalData.phoneVerified || callLog.phoneVerified,
        emailVerified: additionalData.emailVerified || callLog.emailVerified,
        faceVerified: additionalData.faceVerified || callLog.faceVerified,
        chatMessagesCount: additionalData.chatMessagesCount || callLog.chatMessagesCount,
        notes: additionalData.notes || callLog.notes,
        metadata: { ...callLog.metadata, ...additionalData.metadata },
      });

      console.log(`Call log completed: ${callLog.id}, Duration: ${duration}s`);

      // Send post-call summary email if customer email is available
      if (callLog.customerEmail && !callLog.summaryEmailSent) {
        sendPostCallSummaryEmail({
          customerEmail: callLog.customerEmail,
          customerName: callLog.customerName,
          referenceNumber: callLog.referenceNumber,
          managerName: callLog.managerName,
          startTime: callLog.startTime,
          endTime,
          duration,
          status: "completed"
        }).then(async (sent) => {
          if (sent) {
            await callLog.update({
              summaryEmailSent: true,
              summaryEmailSentAt: new Date()
            });
          }
        }).catch(err => console.error('Failed to send summary email:', err));
      }
    }

    return callLog;
  } catch (error) {
    console.error("Error completing call log:", error);
    throw error;
  }
};

/**
 * Mark call as missed (no manager response)
 */
const missCall = async (callRoom) => {
  try {
    const callLog = await CallLog.findOne({
      where: { callRoom, status: "initiated" },
    });

    if (callLog) {
      await callLog.update({
        status: "missed",
        endTime: new Date(),
      });
      console.log(`📝 Call log marked as missed: ${callLog.id}`);
    }

    return callLog;
  } catch (error) {
    console.error("❌ Error marking call as missed:", error);
    throw error;
  }
};

/**
 * Mark call as cancelled (customer cancelled)
 */
const cancelCall = async (callRoom) => {
  try {
    const callLog = await CallLog.findOne({
      where: { callRoom, status: "initiated" },
    });

    if (callLog) {
      await callLog.update({
        status: "cancelled",
        endTime: new Date(),
        endedBy: "customer",
      });
      console.log(`📝 Call log marked as cancelled: ${callLog.id}`);
    }

    return callLog;
  } catch (error) {
    console.error("❌ Error cancelling call log:", error);
    throw error;
  }
};

/**
 * Update verification status during call
 */
const updateVerificationStatus = async (callRoom, verificationType, verified = true) => {
  try {
    const callLog = await CallLog.findOne({
      where: { callRoom, status: "accepted" },
    });

    if (callLog) {
      const updateData = {};

      if (verificationType === "phone") {
        updateData.phoneVerified = verified;
      } else if (verificationType === "email") {
        updateData.emailVerified = verified;
      } else if (verificationType === "face") {
        updateData.faceVerified = verified;
      }

      await callLog.update(updateData);
      console.log(`📝 Call log verification updated: ${callLog.id}, ${verificationType}: ${verified}`);
    }

    return callLog;
  } catch (error) {
    console.error("❌ Error updating verification status:", error);
    throw error;
  }
};

/**
 * Get call logs with filters
 */
const getCallLogs = async (filters = {}, pagination = {}) => {
  try {
    const where = {};
    const { page = 1, limit = 20 } = pagination;
    const offset = (page - 1) * limit;

    // Apply filters
    if (filters.customerPhone) {
      where.customerPhone = filters.customerPhone;
    }
    if (filters.managerEmail) {
      where.managerEmail = filters.managerEmail;
    }
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.startDate && filters.endDate) {
      where.startTime = {
        [Op.between]: [new Date(filters.startDate), new Date(filters.endDate)],
      };
    } else if (filters.startDate) {
      where.startTime = { [Op.gte]: new Date(filters.startDate) };
    } else if (filters.endDate) {
      where.startTime = { [Op.lte]: new Date(filters.endDate) };
    }

    const { count, rows } = await CallLog.findAndCountAll({
      where,
      order: [["startTime", "DESC"]],
      limit,
      offset,
    });

    return {
      callLogs: rows,
      pagination: {
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit),
      },
    };
  } catch (error) {
    console.error("❌ Error fetching call logs:", error);
    throw error;
  }
};

/**
 * Get call statistics
 */
const getCallStatistics = async (filters = {}) => {
  try {
    const where = {};

    if (filters.managerEmail) {
      where.managerEmail = filters.managerEmail;
    }
    if (filters.startDate && filters.endDate) {
      where.startTime = {
        [Op.between]: [new Date(filters.startDate), new Date(filters.endDate)],
      };
    }

    const totalCalls = await CallLog.count({ where });
    const completedCalls = await CallLog.count({
      where: { ...where, status: "completed" },
    });
    const missedCalls = await CallLog.count({
      where: { ...where, status: "missed" },
    });
    const cancelledCalls = await CallLog.count({
      where: { ...where, status: "cancelled" },
    });

    // Calculate average duration for completed calls
    const completedCallsData = await CallLog.findAll({
      where: { ...where, status: "completed", duration: { [Op.not]: null } },
      attributes: ["duration"],
    });

    const totalDuration = completedCallsData.reduce(
      (sum, call) => sum + (call.duration || 0),
      0
    );
    const avgDuration =
      completedCallsData.length > 0
        ? Math.round(totalDuration / completedCallsData.length)
        : 0;

    // Calculate CSAT score from feedback (convert 1-5 rating to 1-10 scale)
    // Use the same date range as call logs to ensure consistency
    const feedbackWhere = {};
    if (filters.managerEmail) {
      feedbackWhere.managerEmail = filters.managerEmail;
    }
    if (filters.startDate && filters.endDate) {
      // Convert dates to proper Date objects and ensure inclusive range
      // Add 1 second to endDate to include the entire end day (handles timezone issues)
      const startDate = new Date(filters.startDate);
      const endDate = new Date(filters.endDate);
      // Extend end date by 1 day to include all feedback from the end date day
      // This ensures we capture feedback created throughout the entire day in Bangladesh timezone
      const extendedEndDate = new Date(endDate);
      extendedEndDate.setDate(extendedEndDate.getDate() + 1);
      
      feedbackWhere.createdAt = {
        [Op.gte]: startDate,
        [Op.lt]: extendedEndDate, // Use less than to exclude next day
      };
      
      console.log(`📊 CSAT Query - Date range: ${startDate.toISOString()} to ${extendedEndDate.toISOString()}, Manager: ${filters.managerEmail || 'all'}`);
    }

    const feedbackData = await CustomerFeedback.findAll({
      where: feedbackWhere,
      attributes: ["rating", "createdAt", "managerEmail"],
    });
    
    console.log(`📊 CSAT Query - Found ${feedbackData.length} feedback records for date range`);

    let csatScore = 7; // Default score if no feedback
    if (feedbackData.length > 0) {
      const totalRating = feedbackData.reduce((sum, fb) => sum + (fb.rating || 0), 0);
      const avgRating = totalRating / feedbackData.length; // Average 1-5
      csatScore = Math.round((avgRating / 5) * 10); // Convert to 1-10 scale
      console.log(`📊 CSAT Calculation - Ratings: ${feedbackData.map(f => f.rating).join(', ')}, Average: ${avgRating.toFixed(2)}, CSAT: ${csatScore}/10`);
    } else {
      console.log(`📊 CSAT Calculation - No feedback found, using default: 7/10`);
    }

    return {
      totalCalls,
      completedCalls,
      missedCalls,
      cancelledCalls,
      completionRate:
        totalCalls > 0 ? Math.round((completedCalls / totalCalls) * 100) : 0,
      avgDuration,
      totalTalkTime: totalDuration,
      csatScore,
      feedbackCount: feedbackData.length,
    };
  } catch (error) {
    console.error("❌ Error fetching call statistics:", error);
    throw error;
  }
};

/**
 * Get single call log by ID
 */
const getCallLogById = async (id) => {
  try {
    const callLog = await CallLog.findByPk(id);
    return callLog;
  } catch (error) {
    console.error("❌ Error fetching call log:", error);
    throw error;
  }
};

/**
 * Get call log by room name
 */
const getCallLogByRoom = async (callRoom) => {
  try {
    const callLog = await CallLog.findOne({
      where: { callRoom },
      order: [["startTime", "DESC"]],
    });
    return callLog;
  } catch (error) {
    console.error("❌ Error fetching call log by room:", error);
    throw error;
  }
};

module.exports = {
  createCallLog,
  acceptCall,
  completeCall,
  missCall,
  cancelCall,
  updateVerificationStatus,
  getCallLogs,
  getCallStatistics,
  getCallLogById,
  getCallLogByRoom,
};
