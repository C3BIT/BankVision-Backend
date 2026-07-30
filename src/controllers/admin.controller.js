const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { AccessToken } = require('livekit-server-sdk');
const { Admin } = require('../models/Admin');
const { Manager, CallLog, CustomerFeedback, Recording, AuthenticationLog, TransactionLog, AdminActivityLog, VerificationLog, ChangeRequest, CallAgentReport, ManagerStatusLog } = require('../models');
const { Op } = require('sequelize');
const { validatePassword, getPasswordRequirements } = require('../utils/passwordPolicy');
const { validatePasswordChange, addToPasswordHistory } = require('../utils/accountSecurity');
const { logAdminActivity, logPasswordChange, logLoginSuccess, logAuthEvent, getClientIP } = require('../services/loggingService');
const { getActiveCallsData, getActiveCallsDataCluster, getOnlineManagersData } = require('../services/socketHandler');
const { getQueueStats } = require('../services/callQueueService');
const { setAuthCookie, clearAuthCookie } = require('../utils/cookieHelper');
const { createSession, invalidateSession } = require('../utils/sessionManager');
const { checkPasswordExpiry } = require('../middlewares/passwordExpiryMiddleware');

const { jwtSecret } = require('../configs/variables');

// In-memory whisper mode state (per server instance)
const whisperModeState = { active: false };

// Admin Registration (usually seeded or created by super admin)
const registerAdmin = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, and password are required'
      });
    }

    // Validate password against policy
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        success: false,
        message: passwordValidation.errors.join('. '),
        errors: passwordValidation.errors,
        requirements: getPasswordRequirements()
      });
    }

    const existingAdmin = await Admin.findOne({ where: { email } });
    if (existingAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Admin with this email already exists'
      });
    }

    // Whitelist the role. Defence in depth alongside the super-admin-only route
    // guard: never trust the client-supplied role verbatim (mass-assignment).
    const ALLOWED_ROLES = ['admin', 'supervisor', 'super_admin'];
    const resolvedRole = ALLOWED_ROLES.includes(role) ? role : 'admin';

    const hashedPassword = await bcrypt.hash(password, 10);

    const admin = await Admin.create({
      name,
      email,
      password: hashedPassword,
      role: resolvedRole
    });

    res.status(201).json({
      success: true,
      message: 'Admin created successfully',
      data: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: admin.role
      }
    });
  } catch (error) {
    console.error('Admin Registration Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create admin'
    });
  }
};

// Admin Login
const loginAdmin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    const admin = await Admin.findOne({ where: { email } });

    if (!admin) {
      // Generic message - don't reveal if email exists
      await logAuthEvent({
        eventType: 'login_failed',
        userType: 'admin',
        userEmail: email,
        ipAddress: getClientIP(req),
        userAgent: req.headers['user-agent'],
        failureReason: 'Unknown email'
      });
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    if (!admin.isActive) {
      // Generic message - don't reveal account status
      await logAuthEvent({
        eventType: 'login_failed',
        userType: 'admin',
        userId: admin.id?.toString(),
        userEmail: email,
        ipAddress: getClientIP(req),
        userAgent: req.headers['user-agent'],
        failureReason: 'Account inactive'
      });
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const isPasswordValid = await bcrypt.compare(password, admin.password);

    if (!isPasswordValid) {
      await logAuthEvent({
        eventType: 'login_failed',
        userType: 'admin',
        userId: admin.id?.toString(),
        userEmail: email,
        ipAddress: getClientIP(req),
        userAgent: req.headers['user-agent'],
        failureReason: 'Invalid password'
      });
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Update last login
    admin.lastLogin = new Date();

    // Safety check: Initialize passwordChangedAt if it's null (for migrated/legacy accounts)
    if (!admin.passwordChangedAt) {
      console.log(`ℹ️ Initializing passwordChangedAt for admin: ${admin.email}`);
      admin.passwordChangedAt = admin.createdAt || new Date();
    }

    await admin.save();

    // Check password expiry (90-day rotation policy)
    const expiryStatus = checkPasswordExpiry(admin.passwordChangedAt);

    if (expiryStatus.isExpired) {
      return res.status(403).json({
        success: false,
        message: 'Your password has expired. Please reset your password to continue.',
        error: {
          code: 40303,
          passwordExpired: true,
          requiresPasswordChange: true
        }
      });
    }

    const token = jwt.sign(
      {
        id: admin.id,
        email: admin.email,
        role: admin.role,
        type: 'admin'
      },
      jwtSecret,
      { expiresIn: '8h' }
    );

    // Set token as httpOnly cookie (secure, cannot be accessed by JavaScript).
    // Distinct cookie name from manager sessions ('manager_auth_token') so a
    // staff member with both an admin and a manager session open in the same
    // browser (shared COOKIE_DOMAIN across subdomains) doesn't have one
    // overwrite the other — previously both used the default 'auth_token' name.
    setAuthCookie(res, token, 8 * 60 * 60 * 1000, 'admin_auth_token'); // 8 hours

    // Track the session so logout/invalidateSession can actually revoke this token
    await createSession(admin.id, token, {
      userAgent: req.headers['user-agent'],
      ipAddress: getClientIP(req)
    });

    // Audit trail for SESSION_SUPERSEDED investigations - this is the only place
    // an admin session gets (re)created, so a login here is what kicks out any
    // previously active session for this account.
    await logLoginSuccess(req, admin, 'admin');

    const responseData = {
      admin: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        profileImage: admin.profileImage
      },
      token: token // Restoring for backward compatibility with frontend
    };

    // Add password expiry warning if applicable
    if (expiryStatus.showWarning) {
      responseData.passwordExpiryWarning = {
        message: `Your password will expire in ${expiryStatus.daysRemaining} days. Please change it soon.`,
        daysRemaining: expiryStatus.daysRemaining
      };
    }

    res.json({
      success: true,
      message: 'Login successful',
      data: responseData
    });
  } catch (error) {
    console.error('Admin Login Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Login failed'
    });
  }
};

// Return the currently authenticated admin, resolved from the auth cookie/token
// via adminAuthenticateMiddleware. Lets the frontend bootstrap session state on
// page load without persisting the admin profile in localStorage.
const getCurrentAdmin = async (req, res) => {
  try {
    const admin = await Admin.findByPk(req.admin.id, {
      attributes: ['id', 'name', 'email', 'role', 'profileImage']
    });

    if (!admin || !admin.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Not authenticated'
      });
    }

    res.json({
      success: true,
      data: { admin }
    });
  } catch (error) {
    console.error('Get Current Admin Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to load admin profile'
    });
  }
};

// Get all managers
const getManagers = async (req, res) => {
  try {
    const managers = await Manager.findAll({
      attributes: ['id', 'name', 'email', 'profileImage', 'isActive', 'lastLogin', 'failedLoginAttempts', 'lockedUntil', 'createdAt'],
      order: [['createdAt', 'DESC']]
    });

    // Merge real-time socket status for each manager
    const onlineManagersData = getOnlineManagersData(); // in-memory from socket handler
    const activeCallsData = getActiveCallsData();

    const enrichedManagers = managers.map(mgr => {
      const plain = mgr.get({ plain: true });
      const liveData = onlineManagersData.find(m => m.email === plain.email) || {};
      const activeCall = activeCallsData.find(c => c.managerEmail === plain.email) || null;

      return {
        ...plain,
        status: liveData.status || 'offline',
        statusChangedAt: liveData.statusChangedAt || null,
        currentCallDuration: activeCall
          ? Math.floor((Date.now() - activeCall.startTime) / 1000)
          : null,
        currentCustomerPhone: activeCall ? activeCall.customerPhone : null,
        currentCallRoom: activeCall ? activeCall.callRoom : null
      };
    });

    // Sidebar summary stats
    const sidebarStats = {
      activeCalls: activeCallsData.length,
      onlineManagers: onlineManagersData.filter(m => m.status === 'online').length,
      busyManagers: onlineManagersData.filter(m => m.status === 'busy').length
    };

    res.json({
      success: true,
      data: enrichedManagers,
      stats: sidebarStats
    });
  } catch (error) {
    console.error('Get Managers Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch managers'
    });
  }
};

// Get dashboard statistics
const getDashboardStats = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // Helper to fetch call stats for a given date range
    const fetchCallStats = async (start, end) => {
      const calls = await CallLog.findAll({
        where: {
          createdAt: {
            [Op.between]: [start, end]
          }
        }
      });
      const total = calls.length;
      const completed = calls.filter(c => c.status === 'completed').length;
      const missed = calls.filter(c => c.status === 'missed' || c.status === 'rejected').length;
      const avgDuration = total > 0
        ? Math.round(calls.reduce((sum, c) => sum + (c.duration || 0), 0) / total)
        : 0;
      return { total, completed, missed, avgDuration };
    };

    // Today's call statistics
    const todayCalls = await CallLog.findAll({
      where: {
        createdAt: {
          [Op.between]: [today, tomorrow]
        }
      }
    });

    const totalCallsToday = todayCalls.length;
    const completedCalls = todayCalls.filter(c => c.status === 'completed').length;
    const missedCalls = todayCalls.filter(c => c.status === 'missed' || c.status === 'rejected').length;
    const avgDuration = totalCallsToday > 0
      ? Math.round(todayCalls.reduce((sum, c) => sum + (c.duration || 0), 0) / totalCallsToday)
      : 0;

    // Total managers
    const totalManagers = await Manager.count();

    // Feedback stats for today
    const todayFeedback = await CustomerFeedback.findAll({
      where: {
        createdAt: {
          [Op.between]: [today, tomorrow]
        }
      }
    });

    const avgRating = todayFeedback.length > 0
      ? (todayFeedback.reduce((sum, f) => sum + f.rating, 0) / todayFeedback.length).toFixed(1)
      : 0;

    // Weekly call trend
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const weeklyCallsRaw = await CallLog.findAll({
      where: {
        createdAt: {
          [Op.gte]: weekAgo
        }
      },
      attributes: ['createdAt', 'status']
    });

    // Group by day
    const weeklyTrend = {};
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      weeklyTrend[dateStr] = { date: dateStr, calls: 0, completed: 0 };
    }

    weeklyCallsRaw.forEach(call => {
      const dateStr = call.createdAt.toISOString().split('T')[0];
      if (weeklyTrend[dateStr]) {
        weeklyTrend[dateStr].calls++;
        if (call.status === 'completed') {
          weeklyTrend[dateStr].completed++;
        }
      }
    });

    // Get real-time active data
    const activeCalls = getActiveCallsData();
    const onlineManagers = getOnlineManagersData();
    console.log('📊 Dashboard API - activeCalls:', activeCalls.length, '- onlineManagers:', onlineManagers.length, onlineManagers);

    // --- NEW: Yesterday stats for % delta calculations ---
    const yesterdayStats = await fetchCallStats(yesterday, today);
    const calcDelta = (todayVal, yesterdayVal) => {
      if (!yesterdayVal) return null;
      return parseFloat(((todayVal - yesterdayVal) / yesterdayVal * 100).toFixed(1));
    };

    // --- NEW: Pending queue count from BullMQ ---
    let pendingInQueue = 0;
    try {
      const queueStats = await getQueueStats();
      pendingInQueue = queueStats.waiting + queueStats.active + queueStats.delayed;
    } catch (e) {
      // Queue service may not be reachable; default to 0
    }

    // Identity match success rate — use CallLog.faceVerified from completed calls today
    // (VerificationLog is not written for face comparisons; CallLog.faceVerified is the source of truth)
    const completedCallsToday = todayCalls.filter(c => c.status === 'completed');
    const faceTotal = completedCallsToday.length;
    const faceVerifiedCount = completedCallsToday.filter(c => c.faceVerified === true).length;
    const identityMatchSuccessRate = faceTotal > 0
      ? parseFloat((faceVerifiedCount / faceTotal * 100).toFixed(1))
      : null;

    // --- NEW: OTP failure rate today (otp type) ---
    const otpLogsToday = await VerificationLog.findAll({
      where: {
        verificationType: 'otp',
        requestedAt: { [Op.between]: [today, tomorrow] }
      },
      attributes: ['status']
    });
    const otpTotal = otpLogsToday.length;
    const otpFailed = otpLogsToday.filter(v => v.status === 'failed').length;
    const otpFailureRate = otpTotal > 0
      ? `${otpFailed}/${otpTotal}`
      : null;

    // --- NEW: Recent calls (last 10) with whisperEnabled ---
    const recentCalls = await CallLog.findAll({
      order: [['createdAt', 'DESC']],
      limit: 10,
      attributes: [
        'id', 'referenceNumber', 'customerPhone', 'customerName',
        'managerEmail', 'managerName', 'duration', 'status',
        'whisperEnabled', 'createdAt'
      ]
    });

    res.json({
      success: true,
      data: {
        today: {
          totalCalls: totalCallsToday,
          completedCalls,
          missedCalls,
          avgDuration,
          avgRating: parseFloat(avgRating),
          pendingInQueue,
          identityMatchSuccessRate,
          otpFailureRate,
          yesterdayDeltas: {
            totalCalls: calcDelta(totalCallsToday, yesterdayStats.total),
            avgDuration: calcDelta(avgDuration, yesterdayStats.avgDuration),
            activeManagers: calcDelta(
              onlineManagers.filter(m => m.status === 'online').length,
              null // no persistent yesterday manager count; future: store snapshot
            )
          }
        },
        totalManagers,
        weeklyTrend: Object.values(weeklyTrend),
        recentCalls,
        realtime: {
          activeCalls: activeCalls.length,
          onlineManagers: onlineManagers.filter(m => m.status === 'online').length,
          busyManagers: onlineManagers.filter(m => m.status === 'busy').length,
          offlineManagers: onlineManagers.filter(m => m.status === 'offline').length
        }
      }
    });
  } catch (error) {
    console.error('Dashboard Stats Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch dashboard stats'
    });
  }
};

// Reset manager password
const resetManagerPassword = async (req, res) => {
  try {
    const { managerId } = req.params;
    const { newPassword } = req.body;

    if (!newPassword) {
      return res.status(400).json({
        success: false,
        message: 'New password is required'
      });
    }

    // Validate password against policy
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        success: false,
        message: passwordValidation.errors.join('. '),
        errors: passwordValidation.errors,
        requirements: getPasswordRequirements()
      });
    }

    const manager = await Manager.findByPk(managerId);

    if (!manager) {
      return res.status(404).json({
        success: false,
        message: 'Invalid manager ID'
      });
    }

    // Cannot reuse the current password or recent password history
    const historyCheck = await validatePasswordChange(
      newPassword,
      manager.password,
      manager.passwordHistory || []
    );

    if (!historyCheck.valid) {
      return res.status(400).json({
        success: false,
        message: historyCheck.message
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    manager.passwordHistory = addToPasswordHistory(manager.password, manager.passwordHistory || []);
    manager.password = hashedPassword;
    manager.passwordChangedAt = new Date();
    await manager.save();

    // Invalidate the manager's existing session so the old credentials/token stop working
    await invalidateSession(manager.id);

    await logAdminActivity({
      activityType: 'user_password_reset',
      adminId: req.admin?.id,
      adminEmail: req.admin?.email,
      adminRole: req.admin?.role,
      targetType: 'manager',
      targetId: manager.id,
      targetEmail: manager.email,
      description: `Admin reset password for manager ${manager.email}`,
      requestPath: req.originalUrl,
      requestMethod: req.method,
      responseStatus: 200,
      ipAddress: getClientIP(req)
    });

    res.json({
      success: true,
      message: 'Password reset successfully'
    });
  } catch (error) {
    console.error('Reset Password Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to reset password'
    });
  }
};

// Get active calls (for supervisor monitoring) - from in-memory socket data
const getActiveCalls = async (req, res) => {
  try {
    // Get real-time active calls, aggregated across all backend pods
    // (in-memory call state is local to whichever pod handled the call).
    const activeCalls = await getActiveCallsDataCluster(req.app.get('io'));
    console.log('📊 Active Calls API - activeCalls:', activeCalls.length);

    // Also get online managers
    const onlineManagers = getOnlineManagersData();
    console.log('📊 Active Calls API - onlineManagers:', onlineManagers.length, onlineManagers);

    res.json({
      success: true,
      data: {
        activeCalls,
        onlineManagers,
        totalActiveCalls: activeCalls.length,
        totalOnlineManagers: onlineManagers.filter(m => m.status === 'online').length,
        totalBusyManagers: onlineManagers.filter(m => m.status === 'busy').length
      }
    });
  } catch (error) {
    console.error('Get Active Calls Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch active calls'
    });
  }
};

// Get call logs with filters
const getCallLogs = async (req, res) => {
  try {
    const { page = 1, limit = 20, startDate, endDate, status, managerEmail, serviceType, disposition } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (startDate && endDate) {
      where.createdAt = {
        [Op.between]: [new Date(startDate), new Date(endDate)]
      };
    }
    if (status) where.status = status;
    if (managerEmail) where.managerEmail = managerEmail;

    // Service type and disposition live on the post-call agent report, not CallLog itself,
    // so filtering on either requires an inner join to CallAgentReport.
    const agentReportWhere = {};
    if (disposition) agentReportWhere.disposition = disposition;
    if (serviceType) {
      // serviceTypes is stored as JSON (LONGTEXT under MariaDB) so a plain column match
      // won't work — LIKE against the raw JSON string is the pragmatic match here.
      agentReportWhere.serviceTypes = { [Op.like]: `%"${serviceType}"%` };
    }
    const needsAgentReportJoin = serviceType || disposition;

    const { count, rows } = await CallLog.findAndCountAll({
      where,
      include: needsAgentReportJoin
        ? [{ model: CallAgentReport, as: 'agentReport', where: agentReportWhere, attributes: ['serviceTypes', 'disposition'], required: true }]
        : [{ model: CallAgentReport, as: 'agentReport', attributes: ['serviceTypes', 'disposition'], required: false }],
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    // Enrich records where managerName is null by looking up Manager table
    const nullNameEmails = [...new Set(
      rows
        .filter(r => !r.managerName && r.managerEmail)
        .map(r => r.managerEmail)
    )];

    let managerNameMap = {};
    if (nullNameEmails.length > 0) {
      const managers = await Manager.findAll({
        where: { email: nullNameEmails },
        attributes: ['email', 'name'],
      });
      managers.forEach(m => { managerNameMap[m.email] = m.name; });
    }

    const calls = rows.map(r => {
      const plain = r.toJSON();
      if (!plain.managerName && plain.managerEmail && managerNameMap[plain.managerEmail]) {
        plain.managerName = managerNameMap[plain.managerEmail];
      }
      // MariaDB has no native JSON type (DataTypes.JSON is aliased to LONGTEXT),
      // so serviceTypes can come back as a raw JSON string instead of an array.
      if (plain.agentReport && typeof plain.agentReport.serviceTypes === 'string') {
        try {
          plain.agentReport.serviceTypes = JSON.parse(plain.agentReport.serviceTypes);
        } catch {
          plain.agentReport.serviceTypes = [];
        }
      }
      return plain;
    });

    res.json({
      success: true,
      data: {
        calls,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Get Call Logs Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch call logs'
    });
  }
};


// Get recordings with filters
const getRecordings = async (req, res) => {
  try {
    const { page = 1, limit = 20, startDate, endDate, status, managerEmail, customerPhone } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (startDate && endDate) {
      where.startTime = {
        [Op.between]: [new Date(startDate), new Date(endDate)]
      };
    }
    if (status) where.status = status;
    if (managerEmail) where.managerEmail = managerEmail;
    if (customerPhone) where.customerPhone = customerPhone;

    const { count, rows } = await Recording.findAndCountAll({
      where,
      order: [['startTime', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
      include: [
        {
          model: CallLog,
          as: 'callLog',
          attributes: ['id', 'referenceNumber', 'customerName', 'managerEmail', 'managerName', 'status', 'duration']
        }
      ]
    });

    res.json({
      success: true,
      data: {
        recordings: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / limit)
        }
      }
    });
  } catch (error) {
    console.error('Get Recordings Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch recordings'
    });
  }
};

// Get single recording
const getRecording = async (req, res) => {
  try {
    const { id } = req.params;

    const recording = await Recording.findByPk(id, {
      include: [
        {
          model: CallLog,
          as: 'callLog',
          attributes: ['id', 'referenceNumber', 'customerName', 'customerPhone', 'managerName', 'status', 'duration']
        }
      ]
    });

    if (!recording) {
      return res.status(404).json({
        success: false,
        message: 'Recording not found'
      });
    }

    res.json({
      success: true,
      data: recording
    });
  } catch (error) {
    console.error('Get Recording Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch recording'
    });
  }
};

// Update recording (notes, status)
const updateRecording = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes, status, filePath, fileSize } = req.body;

    const recording = await Recording.findByPk(id);

    if (!recording) {
      return res.status(404).json({
        success: false,
        message: 'Recording not found'
      });
    }

    if (notes !== undefined) recording.notes = notes;
    if (status) recording.status = status;
    if (filePath) recording.filePath = filePath;
    if (fileSize) recording.fileSize = fileSize;

    await recording.save();

    res.json({
      success: true,
      message: 'Recording updated successfully',
      data: recording
    });
  } catch (error) {
    console.error('Update Recording Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update recording'
    });
  }
};

// Delete recording (soft delete by status)
const deleteRecording = async (req, res) => {
  try {
    const { id } = req.params;

    const recording = await Recording.findByPk(id);

    if (!recording) {
      return res.status(404).json({
        success: false,
        message: 'Recording not found'
      });
    }

    recording.status = 'deleted';
    await recording.save();

    res.json({
      success: true,
      message: 'Recording deleted successfully'
    });
  } catch (error) {
    console.error('Delete Recording Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete recording'
    });
  }
};

// ==================== SECURITY LOGS ====================

// Get Authentication Logs
const getAuthenticationLogs = async (req, res) => {
  try {
    const { page = 1, limit = 50, userEmail, eventType, userType, startDate, endDate } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (userEmail) where.userEmail = { [Op.like]: `%${userEmail}%` };
    if (eventType) where.eventType = eventType;
    if (userType) where.userType = userType;
    if (startDate && endDate) {
      where.timestamp = { [Op.between]: [new Date(startDate), new Date(endDate)] };
    }

    const { count, rows } = await AuthenticationLog.findAndCountAll({
      where,
      order: [['timestamp', 'DESC']],
      limit: parseInt(limit),
      offset
    });

    // Log admin accessing auth logs
    await logAdminActivity({
      activityType: 'audit_log_access',
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      adminName: req.admin.name,
      adminRole: req.admin.role,
      targetType: 'system',
      description: 'Accessed authentication logs',
      ipAddress: getClientIP(req),
      userAgent: req.headers['user-agent'],
      metadata: { filters: { userEmail, eventType, userType, startDate, endDate } }
    });

    res.json({
      success: true,
      data: {
        logs: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit))
        }
      }
    });
  } catch (error) {
    console.error('Get Auth Logs Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch authentication logs'
    });
  }
};

// Get Transaction Logs
const getTransactionLogs = async (req, res) => {
  try {
    const { page = 1, limit = 50, customerPhone, transactionType, status, managerEmail, startDate, endDate } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (customerPhone) where.customerPhone = { [Op.like]: `%${customerPhone}%` };
    if (transactionType) where.transactionType = transactionType;
    if (status) where.status = status;
    if (managerEmail) where.managerEmail = { [Op.like]: `%${managerEmail}%` };
    if (startDate && endDate) {
      where.initiatedAt = { [Op.between]: [new Date(startDate), new Date(endDate)] };
    }

    const { count, rows } = await TransactionLog.findAndCountAll({
      where,
      order: [['initiatedAt', 'DESC']],
      limit: parseInt(limit),
      offset
    });

    res.json({
      success: true,
      data: {
        logs: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit))
        }
      }
    });
  } catch (error) {
    console.error('Get Transaction Logs Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch transaction logs'
    });
  }
};

// Get Admin Activity Logs
const getAdminActivityLogs = async (req, res) => {
  try {
    const { page = 1, limit = 50, adminEmail, activityType, targetType, riskLevel, startDate, endDate } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (adminEmail) where.adminEmail = { [Op.like]: `%${adminEmail}%` };
    if (activityType) where.activityType = activityType;
    if (targetType) where.targetType = targetType;
    if (riskLevel) where.riskLevel = riskLevel;
    if (startDate && endDate) {
      where.timestamp = { [Op.between]: [new Date(startDate), new Date(endDate)] };
    }

    const { count, rows } = await AdminActivityLog.findAndCountAll({
      where,
      order: [['timestamp', 'DESC']],
      limit: parseInt(limit),
      offset
    });

    // Log admin accessing admin activity logs
    await logAdminActivity({
      activityType: 'audit_log_access',
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      adminName: req.admin.name,
      adminRole: req.admin.role,
      targetType: 'system',
      description: 'Accessed admin activity logs',
      ipAddress: getClientIP(req),
      userAgent: req.headers['user-agent']
    });

    res.json({
      success: true,
      data: {
        logs: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit))
        }
      }
    });
  } catch (error) {
    console.error('Get Admin Activity Logs Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch admin activity logs'
    });
  }
};

// Get Security Summary
const getSecuritySummary = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Failed logins today
    const failedLoginsToday = await AuthenticationLog.count({
      where: {
        eventType: 'login_failed',
        timestamp: { [Op.gte]: today }
      }
    });

    // Account lockouts today
    const accountLockoutsToday = await AuthenticationLog.count({
      where: {
        eventType: 'account_locked',
        timestamp: { [Op.gte]: today }
      }
    });

    // Successful logins today
    const successfulLoginsToday = await AuthenticationLog.count({
      where: {
        eventType: 'login_success',
        timestamp: { [Op.gte]: today }
      }
    });

    // High risk admin activities today
    const highRiskActivitiesToday = await AdminActivityLog.count({
      where: {
        riskLevel: { [Op.in]: ['high', 'critical'] },
        timestamp: { [Op.gte]: today }
      }
    });

    // Recent suspicious IPs (more than 5 failed attempts)
    const suspiciousIPs = await AuthenticationLog.findAll({
      attributes: ['ipAddress', [require('sequelize').fn('COUNT', '*'), 'count']],
      where: {
        eventType: 'login_failed',
        timestamp: { [Op.gte]: today }
      },
      group: ['ipAddress'],
      having: require('sequelize').literal('COUNT(*) >= 5'),
      limit: 10
    });

    res.json({
      success: true,
      data: {
        today: {
          failedLogins: failedLoginsToday,
          accountLockouts: accountLockoutsToday,
          successfulLogins: successfulLoginsToday,
          highRiskActivities: highRiskActivitiesToday
        },
        suspiciousIPs: suspiciousIPs.map(ip => ({
          ipAddress: ip.ipAddress,
          failedAttempts: ip.get('count')
        })),
        generatedAt: new Date()
      }
    });
  } catch (error) {
    console.error('Get Security Summary Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch security summary'
    });
  }
};

// ==================== RECORDING DOWNLOAD ====================

// Download or redirect to recording file
const downloadRecording = async (req, res) => {
  try {
    const { id } = req.params;
    const recording = await Recording.findByPk(id);

    if (!recording) {
      return res.status(404).json({ success: false, message: 'Recording not found' });
    }

    if (recording.status !== 'completed') {
      return res.status(400).json({
        success: false,
        message: `Recording is not available for download (status: ${recording.status})`
      });
    }

    const filePath = recording.filePath || '';
    if (!filePath) {
      return res.status(404).json({ success: false, message: 'Recording file not found' });
    }

    const filename = recording.metadata?.filename || path.basename(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'video/mp4');

    // Local file (starts with /uploads/)
    const isLocalFile = filePath.startsWith('/uploads') || filePath.startsWith('uploads/');
    if (isLocalFile) {
      const localPath = path.join(__dirname, '../../', filePath);
      if (!fs.existsSync(localPath)) {
        return res.status(404).json({ success: false, message: 'Recording file not found on disk' });
      }
      return fs.createReadStream(localPath).pipe(res);
    }

    // MinIO file — stream via S3 SDK (authenticated)
    const { S3Client: S3Dl, GetObjectCommand: GetObjDl } = require('@aws-sdk/client-s3');
    const s3 = new S3Dl({
      endpoint: process.env.MINIO_ENDPOINT,
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY,
        secretAccessKey: process.env.MINIO_SECRET_KEY,
      },
      forcePathStyle: true,
    });

    console.log(`📥 Download from MinIO via S3 SDK: bucket=${process.env.MINIO_BUCKET}, key=${filePath}`);

    const getResult = await s3.send(new GetObjDl({
      Bucket: process.env.MINIO_BUCKET,
      Key: filePath,
    }));

    if (getResult.ContentLength) {
      res.setHeader('Content-Length', getResult.ContentLength);
    }
    getResult.Body.pipe(res);
  } catch (error) {
    console.error('Download Recording Error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to download recording' });
  }
};

// ==================== RECORDING STREAMING ====================

const { S3Client, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const getMinioS3Client = () => new S3Client({
  endpoint: process.env.MINIO_ENDPOINT,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
  forcePathStyle: true,
});

// Helper: stream from MinIO with Range support (authenticated via S3 SDK)
const streamFromMinio = async (req, res, key) => {
  const s3 = getMinioS3Client();
  const bucket = process.env.MINIO_BUCKET;

  console.log(`🔗 MinIO S3 stream: bucket=${bucket}, key=${key}`);

  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const totalSize = head.ContentLength;

  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': chunkSize,
    });

    const get = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=${start}-${end}`,
    }));

    get.Body.pipe(res);
  } else {
    res.setHeader('Content-Length', totalSize);

    const get = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }));

    get.Body.pipe(res);
  }
};

// Helper: stream local file with Range support
const streamFromLocalFile = (req, res, storageUrl) => {
  let filePath = storageUrl;
  if (filePath.startsWith('/uploads/') || filePath.startsWith('uploads/')) {
    filePath = path.join(__dirname, '../../', filePath);
  } else if (!path.isAbsolute(filePath)) {
    filePath = path.join(__dirname, '../../uploads/recordings', filePath);
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, message: 'Recording file not found on disk' });
  }

  const stat = fs.statSync(filePath);
  const totalSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': chunkSize,
    });

    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', totalSize);
    fs.createReadStream(filePath).pipe(res);
  }
};

// Stream recording for in-browser playback (supports seeking via Range requests)
const streamRecording = async (req, res) => {
  try {
    const { id } = req.params;
    const recording = await Recording.findByPk(id);

    if (!recording) {
      return res.status(404).json({ success: false, message: 'Recording not found' });
    }

    if (recording.status !== 'completed') {
      return res.status(400).json({
        success: false,
        message: `Recording not available (status: ${recording.status})`
      });
    }

    const filePath = recording.filePath || '';
    if (!filePath) {
      return res.status(404).json({ success: false, message: 'Recording file not found' });
    }

    const filename = recording.metadata?.filename || path.basename(filePath);

    // Determine if file is in MinIO or local storage
    const isLocalFile = filePath.startsWith('/uploads') || filePath.startsWith('uploads/');
    const minioEndpoint = process.env.MINIO_ENDPOINT;
    const minioBucket = process.env.MINIO_BUCKET;

    console.log(`🎥 Stream request for recording ${id}, filePath: ${filePath}, local: ${isLocalFile}, range: ${req.headers.range || 'none'}`);

    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');

    if (!isLocalFile && minioEndpoint && minioBucket) {
      await streamFromMinio(req, res, filePath);
    } else {
      streamFromLocalFile(req, res, filePath);
    }
  } catch (error) {
    console.error('Stream Recording Error:', error.message, error.stack);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: error.message || 'Failed to stream recording' });
    }
  }
};

// ==================== WHISPER / SUPERVISOR MONITORING ====================

// Generate a LiveKit whisper token for silent call listening
const generateWhisperToken = async (req, res) => {
  try {
    const { roomName, mode = 'listen' } = req.body;

    if (!roomName) {
      return res.status(400).json({ success: false, message: 'roomName is required' });
    }

    const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
    const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return res.status(500).json({ success: false, message: 'LiveKit credentials not configured' });
    }

    // Mode is embedded in the identity so downstream clients (the manager's
    // video grid) can tell whisper/listen sessions (must stay hidden) apart
    // from barge sessions (must render visibly, audio+video) — the LiveKit
    // grant alone doesn't expose that distinction to other participants.
    const safeMode = ['listen', 'whisper', 'barge'].includes(mode) ? mode : 'listen';
    const supervisorIdentity = `supervisor_${safeMode}_${req.admin.id}_${Date.now()}`;

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: supervisorIdentity,
      name: `Supervisor: ${req.admin.name || req.admin.email}`,
      ttl: '2h'
    });

    // listen  → receive only, fully hidden
    // whisper → publish audio (to coach the manager); must NOT be a LiveKit
    //           "hidden" participant, since a hidden grant makes the server
    //           withhold this participant's join/track-publish events from
    //           every other client in the room, so the manager would never
    //           even learn the whisper track exists to subscribe to it.
    //           The manager-panel client instead filters this identity out
    //           of the visible video grid so it stays invisible in the UI.
    // barge   → publish audio+video, visible as a participant
    const isListen  = safeMode === 'listen';
    const isBarge   = safeMode === 'barge';
    const isWhisper = safeMode === 'whisper';

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: isBarge || isWhisper,  // whisper and barge can publish audio
      canSubscribe: true,
      canPublishData: isBarge,
      hidden: isListen                   // only pure listen (no publish) stays hidden
    });

    const token = await at.toJwt();

    res.json({
      success: true,
      data: {
        token,
        roomName,
        identity: supervisorIdentity,
        serverUrl: process.env.PUBLIC_LIVEKIT_URL || process.env.LIVEKIT_URL // Public wss:// URL browsers can actually reach; LIVEKIT_URL is internal-only
      }
    });
  } catch (error) {
    console.error('Generate Whisper Token Error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to generate whisper token' });
  }
};

// Toggle global whisper mode on/off
const toggleWhisperMode = async (req, res) => {
  try {
    whisperModeState.active = !whisperModeState.active;

    res.json({
      success: true,
      data: {
        whisperModeActive: whisperModeState.active
      }
    });
  } catch (error) {
    console.error('Toggle Whisper Mode Error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to toggle whisper mode' });
  }
};

// Get current whisper mode state
const getWhisperMode = async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        whisperModeActive: whisperModeState.active
      }
    });
  } catch (error) {
    console.error('Get Whisper Mode Error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to get whisper mode' });
  }
};


const syncRecordings = async (req, res) => {
  try {
    const recordingService = require('../services/recordingService');
    const { Recording } = require('../models');

    // Find all stuck recordings
    const stuckRecordings = await Recording.findAll({
      where: { status: 'recording' }
    });

    console.log(`🧹 Syncing ${stuckRecordings.length} stuck recordings...`);

    const results = [];
    for (const rec of stuckRecordings) {
      try {
        await recordingService.stopRecording(rec.egressId);
        results.push({ id: rec.id, egressId: rec.egressId, status: 'synced' });
      } catch (err) {
        results.push({ id: rec.id, egressId: rec.egressId, status: 'failed', error: err.message });
      }
    }

    res.json({
      success: true,
      message: `Synced ${stuckRecordings.length} recordings`,
      results
    });
  } catch (error) {
    console.error('❌ Sync recordings failed:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Update manager active status (activate / deactivate)
const updateManagerStatus = async (req, res) => {
  try {
    const { managerId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ success: false, message: 'isActive must be a boolean' });
    }

    const manager = await Manager.findByPk(managerId);
    if (!manager) {
      return res.status(404).json({ success: false, message: 'Manager not found' });
    }

    const previousValue = { isActive: manager.isActive };
    manager.isActive = isActive;

    if (!isActive) {
      manager.failedLoginAttempts = 0;
      manager.lockedUntil = null;
    }

    await manager.save();

    await logAdminActivity({
      activityType: isActive ? 'user_activate' : 'user_deactivate',
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      adminName: req.admin.name,
      adminRole: req.admin.role,
      targetType: 'manager',
      targetId: managerId.toString(),
      targetEmail: manager.email,
      description: `${isActive ? 'Activated' : 'Deactivated'} manager: ${manager.email}`,
      previousValue,
      newValue: { isActive },
      ipAddress: getClientIP(req),
      userAgent: req.headers['user-agent']
    });

    res.json({
      success: true,
      message: `Manager ${isActive ? 'activated' : 'deactivated'} successfully`,
      data: { id: manager.id, name: manager.name, email: manager.email, isActive: manager.isActive }
    });
  } catch (error) {
    console.error('Update Manager Status Error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to update manager status' });
  }
};

// Delete manager (super_admin only)
const deleteManager = async (req, res) => {
  try {
    const { managerId } = req.params;

    const manager = await Manager.findByPk(managerId);
    if (!manager) {
      return res.status(404).json({ success: false, message: 'Manager not found' });
    }

    // Reject if manager has an active call
    const activeCallsData = getActiveCallsData();
    const activeCall = activeCallsData.find(c => c.managerEmail === manager.email);
    if (activeCall) {
      return res.status(409).json({ success: false, message: 'Cannot delete manager with an active call. End the call first.' });
    }

    const managerData = { id: manager.id, name: manager.name, email: manager.email };

    await manager.destroy();

    await logAdminActivity({
      activityType: 'manager_delete',
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      adminName: req.admin.name,
      adminRole: req.admin.role,
      targetType: 'manager',
      targetId: managerId.toString(),
      targetEmail: managerData.email,
      description: `Deleted manager: ${managerData.email}`,
      previousValue: managerData,
      ipAddress: getClientIP(req),
      userAgent: req.headers['user-agent']
    });

    res.json({ success: true, message: 'Manager deleted successfully' });
  } catch (error) {
    console.error('Delete Manager Error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to delete manager' });
  }
};

// Agent Monitor data (enriched manager list with today's call stats)
const getAgentMonitorData = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const managers = await Manager.findAll({
      attributes: ['id', 'name', 'email', 'profileImage', 'isActive', 'lastLogin', 'createdAt'],
      order: [['createdAt', 'DESC']]
    });

    // Today's call logs for per-manager stats
    const todayCallLogs = await CallLog.findAll({
      where: { createdAt: { [Op.between]: [today, tomorrow] } },
      attributes: ['managerEmail', 'duration', 'status']
    });

    const managerCallStats = {};
    todayCallLogs.forEach(log => {
      const email = log.managerEmail;
      if (!managerCallStats[email]) {
        managerCallStats[email] = { callsHandled: 0, totalDuration: 0, completedCalls: 0 };
      }
      managerCallStats[email].callsHandled++;
      if (log.status === 'completed') {
        managerCallStats[email].completedCalls++;
        managerCallStats[email].totalDuration += (log.duration || 0);
      }
    });

    const onlineManagersData = getOnlineManagersData();
    const activeCallsData = getActiveCallsData();

    const enrichedManagers = managers.map(mgr => {
      const plain = mgr.get({ plain: true });
      const liveData = onlineManagersData.find(m => m.email === plain.email) || {};
      const activeCall = activeCallsData.find(c => c.managerEmail === plain.email) || null;
      const callStats = managerCallStats[plain.email] || { callsHandled: 0, totalDuration: 0, completedCalls: 0 };

      const avgHandleTime = callStats.completedCalls > 0
        ? Math.round(callStats.totalDuration / callStats.completedCalls)
        : 0;

      let currentActivity = 'offline';
      if (activeCall) {
        currentActivity = 'in-call';
      } else if (liveData.status) {
        if (['break', 'lunch', 'prayer'].includes(liveData.status)) {
          currentActivity = 'on-break';
        } else if (liveData.status !== 'offline') {
          currentActivity = 'idle';
        }
      }

      return {
        ...plain,
        status: liveData.status || 'offline',
        statusChangedAt: liveData.statusChangedAt || null,
        connectedAt: liveData.connectedAt || null,
        currentActivity,
        activeCall: activeCall ? {
          customerName: activeCall.customerName,
          customerPhone: activeCall.customerPhone,
          callRoom: activeCall.callRoom,
          startTime: activeCall.startTime,
          referenceNumber: activeCall.referenceNumber
        } : null,
        callsHandledToday: callStats.callsHandled,
        avgHandleTime
      };
    });

    // Summary stats
    const statusCounts = { online: 0, busy: 0, break: 0, lunch: 0, prayer: 0, not_ready: 0, offline: 0 };
    enrichedManagers.forEach(m => {
      const s = m.status || 'offline';
      if (Object.prototype.hasOwnProperty.call(statusCounts, s)) statusCounts[s]++;
      else statusCounts.offline++;
    });

    res.json({
      success: true,
      data: {
        managers: enrichedManagers,
        summary: {
          total: enrichedManagers.length,
          ...statusCounts,
          inCall: activeCallsData.length
        }
      }
    });
  } catch (error) {
    console.error('Get Agent Monitor Data Error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to fetch agent monitor data' });
  }
};

// ── Service Change Request Audit Log ──────────────────────────────────────────
const getChangeRequests = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 25);
    const offset = (page - 1) * limit;

    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.changeType) where.changeType = req.query.changeType;
    if (req.query.method) where.method = req.query.method;
    if (req.query.customerId) where.customerId = { [Op.like]: `%${req.query.customerId}%` };
    if (req.query.managerId) where.managerId = req.query.managerId;
    if (req.query.dateFrom || req.query.dateTo) {
      where.createdAt = {};
      if (req.query.dateFrom) where.createdAt[Op.gte] = new Date(req.query.dateFrom);
      if (req.query.dateTo) {
        const to = new Date(req.query.dateTo);
        to.setHours(23, 59, 59, 999);
        where.createdAt[Op.lte] = to;
      }
    }

    const { count, rows } = await ChangeRequest.findAndCountAll({
      where,
      include: [
        {
          model: Manager,
          as: 'manager',
          attributes: ['id', 'name', 'email'],
          required: false,
        },
      ],
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });

    res.json({
      success: true,
      data: {
        requests: rows,
        pagination: {
          total: count,
          page,
          limit,
          totalPages: Math.ceil(count / limit),
        },
      },
    });
  } catch (error) {
    console.error('Get Change Requests Error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to fetch change requests' });
  }
};

// ==================== SYSTEM SETTINGS ====================

const { SystemSetting } = require('../models/SystemSetting');

const getSystemSettings = async (req, res) => {
  try {
    const settings = await SystemSetting.findAll();
    const settingsMap = {};
    settings.forEach(s => { settingsMap[s.key] = s.value; });

    res.json({
      success: true,
      data: settingsMap
    });
  } catch (error) {
    console.error('Get System Settings Error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to fetch settings' });
  }
};

const updateSystemSetting = async (req, res) => {
  try {
    const { key, value } = req.body;

    if (!key || value === undefined) {
      return res.status(400).json({ success: false, message: 'Key and value are required' });
    }

    await SystemSetting.setValue(key, value);

    await logAdminActivity(
      req.admin?.id,
      'settings_update',
      `Updated setting: ${key} = ${value}`,
      getClientIP(req)
    );

    res.json({
      success: true,
      message: `Setting "${key}" updated successfully`,
      data: { key, value: String(value) }
    });
  } catch (error) {
    console.error('Update System Setting Error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to update setting' });
  }
};

const logoutAdmin = async (req, res) => {
  try {
    const adminId = req.admin?.id;

    if (adminId) {
      await invalidateSession(adminId);
    }
    clearAuthCookie(res, 'admin_auth_token');

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Admin Logout Error:', error);
    res.status(500).json({ success: false, message: error.message || 'Logout failed' });
  }
};

// Reset an admin's password directly by email — the only way out of the 403
// passwordExpired dead-end in loginAdmin, since that block prevents a
// session/JWT from ever being issued to call an authenticated change-password
// endpoint with. No OTP step: admin accounts are provisioned internally in
// small numbers, so email-ownership verification is skipped by design.
const resetPasswordAdmin = async (req, res) => {
  try {
    const { email, newPassword } = req.body;

    if (!email || !newPassword) {
      return res.status(400).json({ success: false, message: 'Email and new password are required' });
    }

    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        success: false,
        message: passwordValidation.errors.join('. '),
        errors: passwordValidation.errors,
        requirements: getPasswordRequirements()
      });
    }

    const admin = await Admin.findOne({ where: { email } });
    if (!admin) {
      return res.status(400).json({ success: false, message: 'Password reset failed. Please try again or contact support.' });
    }

    const historyCheck = await validatePasswordChange(newPassword, admin.password, admin.passwordHistory || []);
    if (!historyCheck.valid) {
      return res.status(400).json({ success: false, message: historyCheck.message });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    admin.passwordHistory = addToPasswordHistory(admin.password, admin.passwordHistory || []);
    admin.password = hashedPassword;
    admin.passwordChangedAt = new Date();
    admin.failedLoginAttempts = 0;
    admin.lockedUntil = null;
    admin.lastFailedLogin = null;

    await admin.save();
    await invalidateSession(admin.id);
    logPasswordChange(req, email, 'password_reset_success');

    res.json({ success: true, message: 'Password reset successfully. You can now login with your new password.' });
  } catch (error) {
    console.error('Admin Reset Password Error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to reset password' });
  }
};

/**
 * VBRM manager activity/performance report.
 * Aggregates time spent in each presence status (online, busy, break, lunch,
 * prayer, not_ready, offline) alongside call-handling stats, per manager,
 * over a date range.
 * GET /api/admin/manager-activity-report?startDate=&endDate=&managerEmail=
 */
const getManagerActivityReport = async (req, res) => {
  try {
    const { managerEmail } = req.query;
    // Date-only query strings (e.g. "2026-07-20") parse to UTC midnight, which
    // excludes the entire selected end-date from the Op.between window below —
    // push a date-only endDate to the end of that day so today's activity is included.
    const endDate = req.query.endDate ? new Date(req.query.endDate) : new Date();
    if (req.query.endDate && /^\d{4}-\d{2}-\d{2}$/.test(req.query.endDate)) {
      endDate.setUTCHours(23, 59, 59, 999);
    }
    const startDate = req.query.startDate
      ? new Date(req.query.startDate)
      : new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    const statusWhere = {
      createdAt: { [Op.between]: [startDate, endDate] },
    };
    if (managerEmail) statusWhere.managerEmail = managerEmail;

    const statusLogs = await ManagerStatusLog.findAll({
      where: statusWhere,
      order: [['managerEmail', 'ASC'], ['createdAt', 'ASC']],
    });

    // Compute time-in-status per manager by walking consecutive log entries;
    // the final entry's duration is capped at the report window's end.
    const managerStats = {};
    const ensureManager = (email, name) => {
      if (!managerStats[email]) {
        managerStats[email] = {
          managerEmail: email,
          managerName: name || null,
          statusDurationSeconds: { online: 0, busy: 0, break: 0, lunch: 0, prayer: 0, not_ready: 0, offline: 0 },
          statusChanges: 0,
        };
      }
      return managerStats[email];
    };

    const byManager = {};
    statusLogs.forEach((log) => {
      if (!byManager[log.managerEmail]) byManager[log.managerEmail] = [];
      byManager[log.managerEmail].push(log);
    });

    Object.entries(byManager).forEach(([email, logs]) => {
      const stats = ensureManager(email, logs[logs.length - 1]?.managerName);
      stats.statusChanges = logs.length;
      for (let i = 0; i < logs.length; i++) {
        const current = logs[i];
        const next = logs[i + 1];
        const windowEnd = next ? new Date(next.createdAt) : endDate;
        const durationSeconds = Math.max(0, (windowEnd.getTime() - new Date(current.createdAt).getTime()) / 1000);
        if (stats.statusDurationSeconds[current.status] !== undefined) {
          stats.statusDurationSeconds[current.status] += durationSeconds;
        }
      }
    });

    // Merge in call-handling stats for the same window
    const callWhere = {
      createdAt: { [Op.between]: [startDate, endDate] },
    };
    if (managerEmail) callWhere.managerEmail = managerEmail;

    const callLogs = await CallLog.findAll({
      where: callWhere,
      attributes: ['managerEmail', 'managerName', 'status', 'duration'],
    });

    callLogs.forEach((call) => {
      if (!call.managerEmail) return;
      const stats = ensureManager(call.managerEmail, call.managerName);
      stats.totalCalls = (stats.totalCalls || 0) + 1;
      if (call.status === 'completed') {
        stats.completedCalls = (stats.completedCalls || 0) + 1;
        stats.totalCallDurationSeconds = (stats.totalCallDurationSeconds || 0) + (call.duration || 0);
      }
    });

    const report = Object.values(managerStats).map((stats) => {
      const completedCalls = stats.completedCalls || 0;
      const totalCallDurationSeconds = stats.totalCallDurationSeconds || 0;
      return {
        ...stats,
        totalCalls: stats.totalCalls || 0,
        completedCalls,
        avgCallDurationSeconds: completedCalls > 0 ? Math.round(totalCallDurationSeconds / completedCalls) : 0,
      };
    });

    report.sort((a, b) => (b.totalCalls || 0) - (a.totalCalls || 0));

    res.status(200).json({
      success: true,
      data: {
        report,
        range: { startDate: startDate.toISOString(), endDate: endDate.toISOString() },
      },
    });
  } catch (error) {
    console.error('Get Manager Activity Report Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to generate manager activity report',
    });
  }
};

module.exports = {
  registerAdmin,
  loginAdmin,
  logoutAdmin,
  resetPasswordAdmin,
  getCurrentAdmin,
  getChangeRequests,
  getManagers,
  getDashboardStats,
  resetManagerPassword,
  getActiveCalls,
  getCallLogs,
  getRecordings,
  getRecording,
  updateRecording,
  deleteRecording,
  getAuthenticationLogs,
  getTransactionLogs,
  getAdminActivityLogs,
  getSecuritySummary,
  downloadRecording,
  streamRecording,
  generateWhisperToken,
  toggleWhisperMode,
  getWhisperMode,
  syncRecordings,
  updateManagerStatus,
  deleteManager,
  getAgentMonitorData,
  getSystemSettings,
  updateSystemSetting,
  getManagerActivityReport
};
