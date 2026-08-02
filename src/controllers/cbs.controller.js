const cbsService = require("../services/cbsService");
const { getCustomerInfoByAccountNumber } = require("../services/customerService");
const { errorResponseHandler } = require("../middlewares/errorResponseHandler");
const { statusCodes } = require("../utils/statusCodes");
const { isCbsUpstreamError } = require("../utils/cbsFallback");
const { isManagerAssignedToCustomer } = require("../services/socketHandler");
const { getClientIP } = require("../services/loggingService");

// Every CBS endpoint here returns/mutates real customer PII (accounts, cards,
// loans, contact details). A manager may only touch a customer's data while
// they have a live call with that customer — checked against the real-time
// activeCustomerCalls assignment (CallLog.customerAccountNumber is not
// reliably populated by the real call flow, so it can't be used here).
const enforceCallOwnership = async (req, res, identifiers) => {
  const managerEmail = req.user?.email;
  const io = req.app.get("io");
  const granted = await isManagerAssignedToCustomer(managerEmail, identifiers, io);

  console.log(
    `[CBS ACCESS] ${granted ? "GRANTED" : "DENIED"} manager=${managerEmail} ` +
    `${identifiers.phone ? `phone=${identifiers.phone} ` : ""}` +
    `${identifiers.accountNumber ? `accountNumber=${identifiers.accountNumber} ` : ""}` +
    `path=${req.originalUrl} ip=${getClientIP(req)}`
  );

  if (!granted) {
    res.status(statusCodes.FORBIDDEN).json({
      success: false,
      message: "You do not have an active call with this customer",
      error: { code: 40302 }
    });
  }

  return granted;
};

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

    if (!(await enforceCallOwnership(req, res, { phone }))) return;

    const result = await cbsService.lookupCustomerByPhone(phone);
    res.success(result, result.found ? "Customer found" : "Customer not found");
  } catch (error) {
    if (isCbsUpstreamError(error)) {
      console.error(`⚠️ CBS lookup unavailable for ${req.body.phone}: ${error.message}`);
      return res.success({ found: false, cbsUnavailable: true }, "Customer records unavailable — CBS not reachable");
    }
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

    if (!(await enforceCallOwnership(req, res, { accountNumber }))) return;

    const result = await cbsService.requestOtp(accountNumber, type, destination, newValue);
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

    const result = await cbsService.verifyOtp(requestId, otp);
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

    if (!(await enforceCallOwnership(req, res, { accountNumber }))) return;

    const result = await cbsService.updatePhone(accountNumber, requestId, otp, newPhone);
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

    if (!(await enforceCallOwnership(req, res, { accountNumber }))) return;

    const result = await cbsService.updateEmail(accountNumber, requestId, otp, newEmail);
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

    if (!(await enforceCallOwnership(req, res, { accountNumber }))) return;

    const result = await cbsService.updateAddress(accountNumber, requestId, otp, newAddress, addressType);
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

    if (!(await enforceCallOwnership(req, res, { accountNumber }))) return;

    const result = await cbsService.getAccountStatus(accountNumber);
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

    if (!(await enforceCallOwnership(req, res, { accountNumber }))) return;

    const result = await cbsService.activateAccount(accountNumber, requestId, otp, nidNumber);
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

    const result = await cbsService.getPendingRequest(requestId);

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

    if (!(await enforceCallOwnership(req, res, { phone }))) return;

    const accounts = await cbsService.getAccountsWithDetails(phone);
    res.success({ accounts }, "Accounts retrieved successfully");
  } catch (error) {
    if (isCbsUpstreamError(error)) {
      console.error(`⚠️ CBS accounts unavailable for ${req.body.phone}: ${error.message}`);
      return res.success({ accounts: [], cbsUnavailable: true }, "Accounts unavailable — CBS not reachable");
    }
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

    if (!(await enforceCallOwnership(req, res, { phone }))) return;

    const cards = await cbsService.getCardsByPhone(phone);
    res.success({ cards }, "Cards retrieved successfully");
  } catch (error) {
    if (isCbsUpstreamError(error)) {
      console.error(`⚠️ CBS cards unavailable for ${req.body.phone}: ${error.message}`);
      return res.success({ cards: [], cbsUnavailable: true }, "Cards unavailable — CBS not reachable");
    }
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

    if (!(await enforceCallOwnership(req, res, { phone }))) return;

    const loans = await cbsService.getLoansByPhone(phone);
    res.success({ loans }, "Loans retrieved successfully");
  } catch (error) {
    if (isCbsUpstreamError(error)) {
      console.error(`⚠️ CBS loans unavailable for ${req.body.phone}: ${error.message}`);
      return res.success({ loans: [], cbsUnavailable: true }, "Loans unavailable — CBS not reachable");
    }
    errorResponseHandler(error, req, res);
  }
};

/**
 * Get full customer/account details (incl. address, cards, loans) for the
 * manager side of an active call. Manager-panel equivalent of
 * customer.controller.js's handleGetCustomerInfoByAccountNb, which requires
 * the customer's own short-lived OTP-session token — unusable here since the
 * manager's browser is a different device and never holds that cookie.
 * POST /api/cbs/customer/details
 */
const getCustomerDetails = async (req, res) => {
  try {
    const { accountNumber, phone } = req.body;

    if (!accountNumber) {
      throw Object.assign(new Error("Account number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40002 }
      });
    }

    if (!(await enforceCallOwnership(req, res, { phone }))) return;

    const customer = await getCustomerInfoByAccountNumber(accountNumber, phone);
    if (!customer) {
      throw Object.assign(new Error("Customer not found"), {
        status: statusCodes.NOT_FOUND,
        error: { code: 40401 }
      });
    }

    res.success(customer, "Customer details fetched successfully");
  } catch (error) {
    if (isCbsUpstreamError(error)) {
      console.error(`⚠️ CBS customer details unavailable for ${req.body.phone}: ${error.message}`);
      return res.success({ cbsUnavailable: true }, "Customer details unavailable — CBS not reachable");
    }
    errorResponseHandler(error, req, res);
  }
};

module.exports = {
  lookupCustomer,
  getAccounts,
  getCards,
  getLoans,
  getCustomerDetails,
  requestOtp,
  verifyOtp,
  updatePhone,
  updateEmail,
  updateAddress,
  getAccountStatus,
  activateAccount,
  getPendingRequest
};
