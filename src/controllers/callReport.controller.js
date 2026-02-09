const { CallAgentReport, CallLog } = require("../models");
const { Op } = require("sequelize");

/** Allowed service type codes for post-call report (multi-select) */
const ALLOWED_SERVICE_TYPES = [
  "kyc_verification",
  "phone_change",
  "email_change",
  "address_change",
  "dormant_activation",
  "general_inquiry",
  "complaint",
  "document_request",
  "other",
];

/**
 * Submit post-call agent report
 * POST /api/call-reports
 */
const submitReport = async (req, res) => {
  try {
    const { callLogId, serviceTypes, remarks } = req.body;
    const managerEmail = req.user?.email;
    const managerName = req.user?.name || null;

    if (!callLogId) {
      return res.status(400).json({
        success: false,
        message: "Call log ID is required",
      });
    }

    if (!Array.isArray(serviceTypes) || serviceTypes.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one service type is required",
      });
    }

    const invalid = serviceTypes.filter((s) => !ALLOWED_SERVICE_TYPES.includes(s));
    if (invalid.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Invalid service type(s): ${invalid.join(", ")}`,
      });
    }

    const callLog = await CallLog.findByPk(callLogId);
    if (!callLog) {
      return res.status(404).json({
        success: false,
        message: "Call log not found",
      });
    }
    if (callLog.status !== "completed") {
      return res.status(400).json({
        success: false,
        message: "Report can only be submitted for completed calls",
      });
    }
    if (callLog.managerEmail !== managerEmail) {
      return res.status(403).json({
        success: false,
        message: "You can only submit a report for your own calls",
      });
    }

    const existing = await CallAgentReport.findOne({ where: { callLogId } });
    if (existing) {
      await existing.update({ serviceTypes, remarks });
      console.log(`📝 Agent report updated for call ${callLogId}`);
      return res.status(200).json({
        success: true,
        message: "Report updated successfully",
        data: { id: existing.id, callLogId },
      });
    }

    const report = await CallAgentReport.create({
      callLogId,
      managerEmail,
      managerName,
      referenceNumber: callLog.referenceNumber || null,
      serviceTypes,
      remarks: remarks || null,
    });

    console.log(`📝 Post-call report submitted for call ${callLogId} by ${managerEmail}`);

    const io = req.app.get("io");
    if (io) {
      io.emit("stats:update", {
        event: "agent-report-submitted",
        timestamp: Date.now(),
        managerEmail,
        callLogId,
      });
    }

    res.status(201).json({
      success: true,
      message: "Report submitted successfully",
      data: {
        id: report.id,
        callLogId: report.callLogId,
        referenceNumber: report.referenceNumber,
      },
    });
  } catch (error) {
    console.error("Submit call report error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to submit report",
    });
  }
};

/**
 * Get list of agent reports (for CRM / audit)
 * GET /api/call-reports?managerEmail=&startDate=&endDate=&limit=&offset=
 */
const getReports = async (req, res) => {
  try {
    const { managerEmail, startDate, endDate, limit = 50, offset = 0 } = req.query;
    const where = {};

    if (managerEmail) {
      where.managerEmail = managerEmail;
    }
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt[Op.gte] = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        where.createdAt[Op.lte] = end;
      }
    }

    const { count, rows } = await CallAgentReport.findAndCountAll({
      where,
      include: [{ association: "callLog", attributes: ["id", "referenceNumber", "customerPhone", "customerName", "duration", "startTime", "endTime"] }],
      order: [["createdAt", "DESC"]],
      limit: Math.min(parseInt(limit, 10) || 50, 100),
      offset: parseInt(offset, 10) || 0,
    });

    res.status(200).json({
      success: true,
      data: { reports: rows, total: count },
    });
  } catch (error) {
    console.error("Get call reports error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to get reports",
    });
  }
};

/**
 * Get service type options (for frontend multi-select)
 * GET /api/call-reports/service-types
 */
const getServiceTypes = (req, res) => {
  const options = [
    { value: "kyc_verification", label: "KYC / Identity Verification" },
    { value: "phone_change", label: "Phone Number Change" },
    { value: "email_change", label: "Email Change" },
    { value: "address_change", label: "Address Change" },
    { value: "dormant_activation", label: "Dormant Account Activation" },
    { value: "general_inquiry", label: "General Inquiry" },
    { value: "complaint", label: "Complaint" },
    { value: "document_request", label: "Document Request" },
    { value: "other", label: "Other" },
  ];
  res.status(200).json({ success: true, data: options });
};

module.exports = {
  submitReport,
  getReports,
  getServiceTypes,
};
