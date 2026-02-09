/**
 * Centralized Logging Service
 * Handles authentication, transaction, and admin activity logging
 */
const { AuthenticationLog } = require('../models/AuthenticationLog');
const { TransactionLog } = require('../models/TransactionLog');
const { AdminActivityLog } = require('../models/AdminActivityLog');
const { AuditLog } = require('../models/AuditLog');

/**
 * Parse user agent string to extract device info
 */
const parseUserAgent = (userAgent) => {
  if (!userAgent) return null;

  const info = {
    browser: 'Unknown',
    os: 'Unknown',
    device: 'Unknown'
  };

  // Browser detection
  if (userAgent.includes('Chrome')) info.browser = 'Chrome';
  else if (userAgent.includes('Firefox')) info.browser = 'Firefox';
  else if (userAgent.includes('Safari')) info.browser = 'Safari';
  else if (userAgent.includes('Edge')) info.browser = 'Edge';
  else if (userAgent.includes('MSIE') || userAgent.includes('Trident')) info.browser = 'IE';

  // OS detection
  if (userAgent.includes('Windows')) info.os = 'Windows';
  else if (userAgent.includes('Mac')) info.os = 'MacOS';
  else if (userAgent.includes('Linux')) info.os = 'Linux';
  else if (userAgent.includes('Android')) info.os = 'Android';
  else if (userAgent.includes('iOS') || userAgent.includes('iPhone') || userAgent.includes('iPad')) info.os = 'iOS';

  // Device type
  if (userAgent.includes('Mobile')) info.device = 'Mobile';
  else if (userAgent.includes('Tablet') || userAgent.includes('iPad')) info.device = 'Tablet';
  else info.device = 'Desktop';

  return info;
};

/**
 * Get client IP from request
 */
const getClientIP = (req) => {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    req.ip ||
    null;
};

/**
 * Calculate risk score for authentication events
 */
const calculateAuthRiskScore = (data) => {
  let score = 0;
  const factors = [];

  // Failed login attempt
  if (data.eventType === 'login_failed') {
    score += 20;
    factors.push('failed_login');
  }

  // Multiple failed attempts
  if (data.failedAttempts > 3) {
    score += data.failedAttempts * 10;
    factors.push('multiple_failures');
  }

  // Account locked
  if (data.eventType === 'account_locked') {
    score += 50;
    factors.push('account_locked');
  }

  // Unusual time (late night/early morning)
  const hour = new Date().getHours();
  if (hour < 6 || hour > 22) {
    score += 10;
    factors.push('unusual_hour');
  }

  return { score: Math.min(score, 100), factors };
};

// ==================== AUTHENTICATION LOGGING ====================

/**
 * Log authentication event
 */
const logAuthEvent = async (data) => {
  try {
    const { score, factors } = calculateAuthRiskScore(data);

    const log = await AuthenticationLog.create({
      eventType: data.eventType,
      userType: data.userType,
      userId: data.userId || null,
      userEmail: data.userEmail || null,
      userPhone: data.userPhone || null,
      ipAddress: data.ipAddress || null,
      userAgent: data.userAgent || null,
      deviceInfo: parseUserAgent(data.userAgent),
      sessionId: data.sessionId || null,
      failureReason: data.failureReason || null,
      failedAttempts: data.failedAttempts || null,
      riskScore: score,
      riskFactors: factors.length > 0 ? factors : null,
      metadata: data.metadata || null
    });

    // Log to console for monitoring
    const emoji = data.eventType.includes('success') ? '✓' :
                  data.eventType.includes('failed') ? '✗' : '•';
    console.log(`[AUTH] ${emoji} ${data.eventType} | ${data.userEmail || data.userPhone} | IP: ${data.ipAddress}`);

    return log;
  } catch (error) {
    console.error('[AUTH LOG ERROR]', error.message);
    return null;
  }
};

/**
 * Log successful login
 */
const logLoginSuccess = async (req, user, userType) => {
  return logAuthEvent({
    eventType: 'login_success',
    userType,
    userId: user.id?.toString(),
    userEmail: user.email,
    userPhone: user.phone,
    ipAddress: getClientIP(req),
    userAgent: req.headers['user-agent'],
    sessionId: req.sessionID
  });
};

/**
 * Log failed login
 */
const logLoginFailed = async (req, email, reason, failedAttempts = null) => {
  return logAuthEvent({
    eventType: 'login_failed',
    userType: 'manager', // Adjust based on context
    userEmail: email,
    ipAddress: getClientIP(req),
    userAgent: req.headers['user-agent'],
    failureReason: reason,
    failedAttempts
  });
};

/**
 * Log account locked
 */
const logAccountLocked = async (req, email, failedAttempts) => {
  return logAuthEvent({
    eventType: 'account_locked',
    userType: 'manager',
    userEmail: email,
    ipAddress: getClientIP(req),
    userAgent: req.headers['user-agent'],
    failedAttempts,
    failureReason: 'Too many failed attempts'
  });
};

/**
 * Log logout
 */
const logLogout = async (req, user, userType) => {
  return logAuthEvent({
    eventType: 'logout',
    userType,
    userId: user?.id?.toString(),
    userEmail: user?.email,
    ipAddress: getClientIP(req),
    userAgent: req.headers['user-agent'],
    sessionId: req.sessionID
  });
};

/**
 * Log password change
 */
const logPasswordChange = async (req, email, eventType = 'password_change') => {
  return logAuthEvent({
    eventType,
    userType: 'manager',
    userEmail: email,
    ipAddress: getClientIP(req),
    userAgent: req.headers['user-agent']
  });
};

// ==================== TRANSACTION LOGGING ====================

/**
 * Log transaction
 */
const logTransaction = async (data) => {
  try {
    const referenceNumber = data.referenceNumber || TransactionLog.generateReference();

    const log = await TransactionLog.create({
      transactionType: data.transactionType,
      status: data.status || 'initiated',
      customerPhone: data.customerPhone,
      customerName: data.customerName || null,
      customerAccountNumber: data.customerAccountNumber || null,
      managerId: data.managerId || null,
      managerEmail: data.managerEmail || null,
      managerName: data.managerName || null,
      callLogId: data.callLogId || null,
      referenceNumber,
      previousValue: data.previousValue || null,
      newValue: data.newValue || null,
      requestData: data.requestData || null,
      verificationMethod: data.verificationMethod || null,
      verificationStatus: data.verificationStatus || null,
      ipAddress: data.ipAddress || null,
      userAgent: data.userAgent || null,
      channel: data.channel || 'video_call',
      metadata: data.metadata || null,
      notes: data.notes || null
    });

    console.log(`[TXN] ${data.transactionType} | ${data.customerPhone} | Ref: ${referenceNumber}`);

    return log;
  } catch (error) {
    console.error('[TXN LOG ERROR]', error.message);
    return null;
  }
};

/**
 * Update transaction status
 */
const updateTransactionStatus = async (transactionId, status, additionalData = {}) => {
  try {
    const transaction = await TransactionLog.findByPk(transactionId);

    if (!transaction) {
      console.error(`[TXN] Transaction not found: ${transactionId}`);
      return null;
    }

    const updateData = {
      status,
      ...additionalData
    };

    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      updateData.completedAt = new Date();
    }

    await transaction.update(updateData);

    console.log(`[TXN] Updated ${transactionId} to ${status}`);

    return transaction;
  } catch (error) {
    console.error('[TXN UPDATE ERROR]', error.message);
    return null;
  }
};

// ==================== ADMIN ACTIVITY LOGGING ====================

/**
 * Log admin activity
 */
const logAdminActivity = async (data) => {
  try {
    const riskLevel = AdminActivityLog.getRiskLevel(data.activityType);
    const requiresReview = ['critical', 'high'].includes(riskLevel);

    const log = await AdminActivityLog.create({
      activityType: data.activityType,
      adminId: data.adminId,
      adminEmail: data.adminEmail,
      adminName: data.adminName || null,
      adminRole: data.adminRole || null,
      targetType: data.targetType || null,
      targetId: data.targetId || null,
      targetEmail: data.targetEmail || null,
      description: data.description,
      previousValue: data.previousValue || null,
      newValue: data.newValue || null,
      requestPath: data.requestPath || null,
      requestMethod: data.requestMethod || null,
      requestBody: data.requestBody || null,
      responseStatus: data.responseStatus || null,
      ipAddress: data.ipAddress || null,
      userAgent: data.userAgent || null,
      sessionId: data.sessionId || null,
      riskLevel,
      requiresReview,
      metadata: data.metadata || null
    });

    const emoji = riskLevel === 'critical' ? '🚨' :
                  riskLevel === 'high' ? '⚠️' :
                  riskLevel === 'medium' ? '📋' : '📝';

    console.log(`[ADMIN] ${emoji} ${data.activityType} | ${data.adminEmail} | Target: ${data.targetEmail || data.targetId || 'N/A'}`);

    return log;
  } catch (error) {
    console.error('[ADMIN LOG ERROR]', error.message);
    return null;
  }
};

/**
 * Express middleware to log admin activities
 */
const adminActivityLogger = (activityType, options = {}) => {
  return async (req, res, next) => {
    // Store original end function
    const originalEnd = res.end;

    // Override end to capture response
    res.end = async function(chunk, encoding) {
      // Restore original end
      res.end = originalEnd;

      // Log the activity
      if (req.admin) {
        await logAdminActivity({
          activityType,
          adminId: req.admin.id,
          adminEmail: req.admin.email,
          adminName: req.admin.name,
          adminRole: req.admin.role,
          targetType: options.targetType || null,
          targetId: req.params.id || req.body?.id || null,
          targetEmail: req.body?.email || null,
          description: options.description || `Admin performed ${activityType}`,
          previousValue: req.previousValue || null,
          newValue: options.logBody ? req.body : null,
          requestPath: req.originalUrl,
          requestMethod: req.method,
          requestBody: options.logBody ? sanitizeRequestBody(req.body) : null,
          responseStatus: res.statusCode,
          ipAddress: getClientIP(req),
          userAgent: req.headers['user-agent'],
          sessionId: req.sessionID
        });
      }

      // Call original end
      return res.end(chunk, encoding);
    };

    next();
  };
};

/**
 * Sanitize request body for logging (remove sensitive data)
 */
const sanitizeRequestBody = (body) => {
  if (!body) return null;

  const sanitized = { ...body };
  const sensitiveFields = ['password', 'token', 'otp', 'secret', 'key', 'pin'];

  sensitiveFields.forEach(field => {
    if (sanitized[field]) {
      sanitized[field] = '[REDACTED]';
    }
  });

  return sanitized;
};

// ==================== QUERY FUNCTIONS ====================

/**
 * Get authentication logs with filters
 */
const getAuthLogs = async (filters = {}, pagination = {}) => {
  const { page = 1, limit = 50 } = pagination;
  const offset = (page - 1) * limit;

  const where = {};
  if (filters.userEmail) where.userEmail = filters.userEmail;
  if (filters.eventType) where.eventType = filters.eventType;
  if (filters.userType) where.userType = filters.userType;
  if (filters.ipAddress) where.ipAddress = filters.ipAddress;

  const { count, rows } = await AuthenticationLog.findAndCountAll({
    where,
    order: [['timestamp', 'DESC']],
    limit,
    offset
  });

  return {
    logs: rows,
    pagination: {
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit)
    }
  };
};

/**
 * Get transaction logs with filters
 */
const getTransactionLogs = async (filters = {}, pagination = {}) => {
  const { page = 1, limit = 50 } = pagination;
  const offset = (page - 1) * limit;

  const where = {};
  if (filters.customerPhone) where.customerPhone = filters.customerPhone;
  if (filters.transactionType) where.transactionType = filters.transactionType;
  if (filters.status) where.status = filters.status;
  if (filters.managerEmail) where.managerEmail = filters.managerEmail;

  const { count, rows } = await TransactionLog.findAndCountAll({
    where,
    order: [['initiatedAt', 'DESC']],
    limit,
    offset
  });

  return {
    logs: rows,
    pagination: {
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit)
    }
  };
};

/**
 * Get admin activity logs with filters
 */
const getAdminActivityLogs = async (filters = {}, pagination = {}) => {
  const { page = 1, limit = 50 } = pagination;
  const offset = (page - 1) * limit;

  const where = {};
  if (filters.adminEmail) where.adminEmail = filters.adminEmail;
  if (filters.activityType) where.activityType = filters.activityType;
  if (filters.targetType) where.targetType = filters.targetType;
  if (filters.riskLevel) where.riskLevel = filters.riskLevel;
  if (filters.requiresReview !== undefined) where.requiresReview = filters.requiresReview;

  const { count, rows } = await AdminActivityLog.findAndCountAll({
    where,
    order: [['timestamp', 'DESC']],
    limit,
    offset
  });

  return {
    logs: rows,
    pagination: {
      total: count,
      page,
      limit,
      totalPages: Math.ceil(count / limit)
    }
  };
};

module.exports = {
  // Utilities
  parseUserAgent,
  getClientIP,
  sanitizeRequestBody,

  // Authentication Logging
  logAuthEvent,
  logLoginSuccess,
  logLoginFailed,
  logAccountLocked,
  logLogout,
  logPasswordChange,

  // Transaction Logging
  logTransaction,
  updateTransactionStatus,

  // Admin Activity Logging
  logAdminActivity,
  adminActivityLogger,

  // Query Functions
  getAuthLogs,
  getTransactionLogs,
  getAdminActivityLogs
};
