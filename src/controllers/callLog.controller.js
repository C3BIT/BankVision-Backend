const callLogService = require("../services/callLogService");

/**
 * Get all call logs with filters and pagination
 */
const getCallLogs = async (req, res) => {
  try {
    const { customerPhone, status, startDate, endDate, page, limit } = req.query;

    const filters = {};
    if (customerPhone) filters.customerPhone = customerPhone;
    // A manager token may only list its OWN calls — the managerEmail query
    // filter is forced to the authenticated manager and never taken from the
    // client (prevents reading other managers' logs via this endpoint).
    filters.managerEmail = req.user.email;
    if (status) filters.status = status;
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;

    const pagination = {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
    };

    const result = await callLogService.getCallLogs(filters, pagination);

    res.status(200).json({
      success: true,
      data: result.callLogs,
      pagination: result.pagination,
    });
  } catch (error) {
    console.error("Error fetching call logs:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch call logs",
      error: error.message,
    });
  }
};

/**
 * Get call statistics
 */
const getCallStatistics = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const filters = {};
    // Force manager scope to the authenticated caller (see getCallLogs).
    filters.managerEmail = req.user.email;

    // Handle date filtering with Bangladesh timezone (UTC+6)
    if (startDate && endDate) {
      // Ensure dates are properly parsed
      const start = new Date(startDate);
      const end = new Date(endDate);

      // Validate that dates are actually valid to prevent toISOString() crashes
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        console.warn(`⚠️ Invalid date format received: startDate=${startDate}, endDate=${endDate}`);
        // Fallback to today if dates are invalid
        const now = new Date();
        const bangladeshOffset = 6 * 60 * 60 * 1000;
        const today = new Date(now.getTime() + bangladeshOffset);
        today.setUTCHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

        filters.startDate = new Date(today.getTime() - bangladeshOffset).toISOString();
        filters.endDate = new Date(tomorrow.getTime() - bangladeshOffset).toISOString();
      } else {
        // Extend end date to include the entire day (add 1 day and subtract 1ms)
        const extendedEnd = new Date(end);
        extendedEnd.setUTCDate(extendedEnd.getUTCDate() + 1);
        extendedEnd.setUTCMilliseconds(extendedEnd.getUTCMilliseconds() - 1);

        filters.startDate = start.toISOString();
        filters.endDate = extendedEnd.toISOString();

        console.log(`📊 Statistics request - Date range: ${filters.startDate} to ${filters.endDate}, Manager: ${filters.managerEmail || 'all'}`);
      }
    } else {
      // If no dates provided, calculate "today" in Bangladesh timezone (UTC+6)
      const now = new Date();
      const bangladeshOffset = 6 * 60 * 60 * 1000; // UTC+6
      const bangladeshTime = new Date(now.getTime() + bangladeshOffset);

      const today = new Date(bangladeshTime);
      today.setUTCHours(0, 0, 0, 0);

      const tomorrow = new Date(today);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

      // Convert back to UTC
      filters.startDate = new Date(today.getTime() - bangladeshOffset).toISOString();
      filters.endDate = new Date(tomorrow.getTime() - bangladeshOffset).toISOString();

      console.log(`📊 Statistics request - Using today in Bangladesh timezone: ${filters.startDate} to ${filters.endDate}`);
    }

    const stats = await callLogService.getCallStatistics(filters);

    res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error("Error fetching call statistics:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch call statistics",
      error: error.message,
    });
  }
};

/**
 * Get single call log by ID
 */
const getCallLogById = async (req, res) => {
  try {
    const { id } = req.params;

    const callLog = await callLogService.getCallLogById(id);

    if (!callLog) {
      return res.status(404).json({
        success: false,
        message: "Call log not found",
      });
    }

    // A manager may only read a call log they handled. Compare against the
    // authenticated email rather than returning any record by id (IDOR).
    if (callLog.managerEmail && req.user?.email && callLog.managerEmail !== req.user.email) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to view this call log",
      });
    }

    res.status(200).json({
      success: true,
      data: callLog,
    });
  } catch (error) {
    console.error("Error fetching call log:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch call log",
      error: error.message,
    });
  }
};

/**
 * Get call logs for a specific customer
 */
const getCustomerCallLogs = async (req, res) => {
  try {
    const { customerPhone } = req.params;
    const { page, limit } = req.query;

    const pagination = {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
    };

    // Managers may review a customer's history only for calls THEY handled —
    // scoping by the authenticated manager's email prevents pulling an arbitrary
    // customer's full cross-manager call history.
    const result = await callLogService.getCallLogs(
      { customerPhone, managerEmail: req.user.email },
      pagination
    );

    res.status(200).json({
      success: true,
      data: result.callLogs,
      pagination: result.pagination,
    });
  } catch (error) {
    console.error("Error fetching customer call logs:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch customer call logs",
      error: error.message,
    });
  }
};

/**
 * Get call logs for a specific manager
 */
const getManagerCallLogs = async (req, res) => {
  try {
    const { page, limit, startDate, endDate } = req.query;

    // Scope to the authenticated manager. The :managerEmail path param is
    // ignored for authorization — a manager may only read their OWN call logs,
    // not another manager's by supplying their address (broken object-level
    // authorization).
    const filters = { managerEmail: req.user.email };
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;

    const pagination = {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
    };

    const result = await callLogService.getCallLogs(filters, pagination);

    res.status(200).json({
      success: true,
      data: result.callLogs,
      pagination: result.pagination,
    });
  } catch (error) {
    console.error("Error fetching manager call logs:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch manager call logs",
      error: error.message,
    });
  }
};

/**
 * Get manager statistics
 */
const getManagerStatistics = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Scope to the authenticated manager (ignore the :managerEmail path param
    // for authorization) — same reasoning as getManagerCallLogs.
    const filters = { managerEmail: req.user.email };
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;

    const stats = await callLogService.getCallStatistics(filters);

    res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error("Error fetching manager statistics:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch manager statistics",
      error: error.message,
    });
  }
};

module.exports = {
  getCallLogs,
  getCallStatistics,
  getCallLogById,
  getCustomerCallLogs,
  getManagerCallLogs,
  getManagerStatistics,
};
