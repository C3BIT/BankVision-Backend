const cbsMockService = require("../services/cbsMockService");
const { errorResponseHandler } = require("../middlewares/errorResponseHandler");
const { statusCodes } = require("../utils/statusCodes");

/**
 * Customer Lookup by Phone
 * POST /api/cbs/customer/lookup
 */
const lookupCustomer = async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      throw Object.assign(new Error("Phone number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 }
      });
    }

    const result = await cbsMockService.lookupCustomerByPhone(phone);
    res.success(result, result.found ? "Customer found" : "Customer not found");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

/**
 * Request OTP
 * POST /api/cbs/otp/request
 */
const requestOtp = async (req, res) => {
  try {
    const { accountNumber, type, destination, newValue } = req.body;

    if (!accountNumber) {
      throw Object.assign(new Error("Account number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40002 }
      });
    }

    if (!type) {
      throw Object.assign(new Error("Request type is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40001 }
      });
    }

    if (!destination) {
      throw Object.assign(new Error("Destination is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40001 }
      });
    }

    const result = await cbsMockService.requestOtp(accountNumber, type, destination, newValue);
    res.success(result, "OTP request processed");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

/**
 * Verify OTP
 * POST /api/cbs/otp/verify
 */
const verifyOtp = async (req, res) => {
  try {
    const { requestId, otp } = req.body;

    if (!requestId) {
      throw Object.assign(new Error("Request ID is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40001 }
      });
    }

    if (!otp) {
      throw Object.assign(new Error("OTP is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40001 }
      });
    }

    const result = await cbsMockService.verifyOtp(requestId, otp);
    res.success(result, result.verified ? "OTP verified" : "OTP verification failed");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

/**
 * Update Phone Number
 * POST /api/cbs/phone/update
 */
const updatePhone = async (req, res) => {
  try {
    const { accountNumber, requestId, otp, newPhone } = req.body;

    if (!accountNumber || !requestId || !otp || !newPhone) {
      throw Object.assign(new Error("Missing required fields"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40001 }
      });
    }

    const result = await cbsMockService.updatePhone(accountNumber, requestId, otp, newPhone);
    res.success(result, result.success ? "Phone updated" : "Update failed");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

/**
 * Update Email
 * POST /api/cbs/email/update
 */
const updateEmail = async (req, res) => {
  try {
    const { accountNumber, requestId, otp, newEmail } = req.body;

    if (!accountNumber || !requestId || !otp || !newEmail) {
      throw Object.assign(new Error("Missing required fields"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40001 }
      });
    }

    const result = await cbsMockService.updateEmail(accountNumber, requestId, otp, newEmail);
    res.success(result, result.success ? "Email updated" : "Update failed");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

/**
 * Update Address
 * POST /api/cbs/address/update
 */
const updateAddress = async (req, res) => {
  try {
    const { accountNumber, requestId, otp, newAddress, addressType } = req.body;

    if (!accountNumber || !requestId || !otp || !newAddress) {
      throw Object.assign(new Error("Missing required fields"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40001 }
      });
    }

    const result = await cbsMockService.updateAddress(accountNumber, requestId, otp, newAddress, addressType);
    res.success(result, result.success ? "Address updated" : "Update failed");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

/**
 * Get Account Status
 * POST /api/cbs/account/status
 */
const getAccountStatus = async (req, res) => {
  try {
    const { accountNumber } = req.body;

    if (!accountNumber) {
      throw Object.assign(new Error("Account number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40002 }
      });
    }

    const result = await cbsMockService.getAccountStatus(accountNumber);
    res.success(result, "Account status retrieved");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

/**
 * Activate Dormant Account
 * POST /api/cbs/account/activate
 */
const activateAccount = async (req, res) => {
  try {
    const { accountNumber, requestId, otp, nidNumber } = req.body;

    if (!accountNumber || !requestId || !otp || !nidNumber) {
      throw Object.assign(new Error("Missing required fields"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40001 }
      });
    }

    const result = await cbsMockService.activateAccount(accountNumber, requestId, otp, nidNumber);
    res.success(result, result.success ? "Account activated" : "Activation failed");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

/**
 * Get Pending Request (Development only)
 * GET /api/cbs/request/:requestId
 */
const getPendingRequest = async (req, res) => {
  try {
    const { requestId } = req.params;

    if (process.env.NODE_ENV !== "development") {
      throw Object.assign(new Error("Not available in production"), {
        status: statusCodes.FORBIDDEN,
        error: { code: 40301 }
      });
    }

    const result = cbsMockService.getPendingRequest(requestId);

    if (!result) {
      throw Object.assign(new Error("Request not found"), {
        status: statusCodes.NOT_FOUND,
        error: { code: 40401 }
      });
    }

    res.success(result, "Request details retrieved");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

/**
 * Get Accounts with Details
 * POST /api/cbs/customer/accounts
 */
const getAccounts = async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      throw Object.assign(new Error("Phone number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 }
      });
    }

    const accounts = await cbsMockService.getAccountsWithDetails(phone);
    res.success({ accounts }, "Accounts retrieved successfully");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

/**
 * Get Cards by Phone
 * POST /api/cbs/customer/cards
 */
const getCards = async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      throw Object.assign(new Error("Phone number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 }
      });
    }

    const cards = await cbsMockService.getCardsByPhone(phone);
    res.success({ cards }, "Cards retrieved successfully");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

/**
 * Get Loans by Phone
 * POST /api/cbs/customer/loans
 */
const getLoans = async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      throw Object.assign(new Error("Phone number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 }
      });
    }

    const loans = await cbsMockService.getLoansByPhone(phone);
    res.success({ loans }, "Loans retrieved successfully");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

module.exports = {
  lookupCustomer,
  getAccounts,
  getCards,
  getLoans,
  requestOtp,
  verifyOtp,
  updatePhone,
  updateEmail,
  updateAddress,
  getAccountStatus,
  activateAccount,
  getPendingRequest
};
