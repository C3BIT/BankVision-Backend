const nidMockService = require("../services/nidMockService");

/**
 * Lookup NID information
 * GET /api/nid/lookup/:nidNumber
 */
const lookupNID = async (req, res) => {
  try {
    const { nidNumber } = req.params;

    if (!nidNumber) {
      return res.status(400).json({
        success: false,
        message: "NID number is required"
      });
    }

    const result = await nidMockService.lookupNID(nidNumber);

    if (!result.found) {
      return res.status(404).json({
        success: false,
        message: result.error || "NID not found"
      });
    }

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error("NID Lookup Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to lookup NID"
    });
  }
};

/**
 * Initiate NID verification
 * POST /api/nid/verify/initiate
 */
const initiateVerification = async (req, res) => {
  try {
    const { nidNumber, customerName, accountNumber } = req.body;

    if (!nidNumber || !customerName) {
      return res.status(400).json({
        success: false,
        message: "NID number and customer name are required"
      });
    }

    const result = await nidMockService.initiateVerification(
      nidNumber,
      customerName,
      accountNumber
    );

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error("NID Verification Initiation Error:", error);
    res.status(400).json({
      success: false,
      message: error.message || "Failed to initiate verification"
    });
  }
};

/**
 * Submit face match result
 * POST /api/nid/verify/face
 */
const submitFaceMatch = async (req, res) => {
  try {
    const { verificationId, capturedImagePath, matchScore } = req.body;

    if (!verificationId) {
      return res.status(400).json({
        success: false,
        message: "Verification ID is required"
      });
    }

    const result = await nidMockService.submitFaceMatch(
      verificationId,
      capturedImagePath,
      matchScore
    );

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error("Face Match Submission Error:", error);
    res.status(400).json({
      success: false,
      message: error.message || "Failed to submit face match"
    });
  }
};

/**
 * Complete NID verification
 * POST /api/nid/verify/complete
 */
const completeVerification = async (req, res) => {
  try {
    const { verificationId } = req.body;

    if (!verificationId) {
      return res.status(400).json({
        success: false,
        message: "Verification ID is required"
      });
    }

    const result = await nidMockService.completeVerification(verificationId);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error("Verification Completion Error:", error);
    res.status(400).json({
      success: false,
      message: error.message || "Failed to complete verification"
    });
  }
};

/**
 * Get verification status
 * GET /api/nid/verify/status/:verificationId
 */
const getVerificationStatus = async (req, res) => {
  try {
    const { verificationId } = req.params;

    if (!verificationId) {
      return res.status(400).json({
        success: false,
        message: "Verification ID is required"
      });
    }

    const result = nidMockService.getVerificationStatus(verificationId);

    if (!result.found) {
      return res.status(404).json({
        success: false,
        message: result.error || "Verification not found"
      });
    }

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error("Get Verification Status Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to get verification status"
    });
  }
};

module.exports = {
  lookupNID,
  initiateVerification,
  submitFaceMatch,
  completeVerification,
  getVerificationStatus
};
