const { errorResponseHandler } = require("../middlewares/errorResponseHandler");
const {
  createCustomer,
  getAccountsListByPhone,
  updatePhoneByAccountNumber,
  updateEmailByAccountNumber,
  updateAddressByAccountNumber,
  getCustomerInfoByAccountNumber,
  getCustomerImageByPhone,
  checkVerificationStatus,
} = require("../services/customerService");
const { generateRandomNumberBySize } = require("../utils/generateRandomNumber");
const { statusCodes } = require("../utils/statusCodes");
const { isCbsUpstreamError } = require("../utils/cbsFallback");
const { createCustomerSchema } = require("../validations/customerValidations");

// Ensures the account being modified actually belongs to the OTP-verified
// caller (req.customerPhone is set from the signed JWT, never the body). Without
// this, any customer with a valid session could pass another customer's
// accountNumber and mutate that victim's contact/address record — the same
// trust-the-client-identifier flaw as the OTP bypass. Mirrors the ownership
// check already present in handleGetCustomerInfoByAccountNb.
// Local phone normalizer (matches the socket layer): strip non-digits, drop BD
// country code, ensure a single leading 0.
const normalizePhoneValue = (phone) => {
  if (!phone) return "";
  let c = String(phone).replace(/\D/g, "");
  if (c.startsWith("880") && c.length > 10) c = c.substring(3);
  if (c.startsWith("1") && c.length === 10) c = "0" + c;
  return c;
};

const assertAccountOwnedByCaller = async (accountNumber, callerPhone) => {
  const accounts = await getAccountsListByPhone(callerPhone).catch(() => []);
  const owns = Array.isArray(accounts) &&
    accounts.some((a) => String(a.accountNumber) === String(accountNumber));
  if (!owns) {
    throw Object.assign(new Error("This account does not belong to the verified caller"), {
      status: statusCodes.UNAUTHORIZED,
      error: { code: 40118 },
    });
  }
};

const createCustomerController = async (req, res) => {
  try {
    const { mobileNumber, email, name, address, branch, profileImage } =
      req.body;
    const { error } = createCustomerSchema.validate({
      mobileNumber,
      email,
      name,
      address,
      branch,
      profileImage,
    });
    if (error) {
      throw Object.assign(new Error(error.details[0].message), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40001 },
      });
    }
    const accountNumber = generateRandomNumberBySize(10);
    const customer = await createCustomer({
      accountNumber,
      mobileNumber,
      email,
      name,
      address,
      branch,
      profileImage,
    });
    res.created(customer, "Customer Created Successfully.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

// Used both to look up the verified caller's own accounts (Home.jsx post-call-start)
// and to duplicate-check a DIFFERENT candidate phone during a change-request flow
// (ChangeContactModal.jsx) — so this intentionally only requires a valid customer
// session, not that `phone` equals the session's own verified number.
const getAccountsListByPhoneController = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }
    const accounsList = await getAccountsListByPhone(phone);

    // A customer querying a number OTHER than their own verified number only
    // ever needs an existence signal (change-contact duplicate check). Returning
    // the full CBS account list there turns this into a PII/account-number
    // enumeration oracle. Redact to existence-only for that case; a customer
    // querying their own number, and managers (trusted operators, no
    // req.customerPhone), still receive full data.
    if (req.customerPhone && normalizePhoneValue(phone) !== normalizePhoneValue(req.customerPhone)) {
      const existenceOnly = (accounsList || []).map(() => ({}));
      return res.success(existenceOnly, "Account List by Phone Fetched Successfully");
    }

    res.success(accounsList, "Account List by Phone Fetched Successfully");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const checkDuplicateEmailController = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40010 },
      });
    }
    const { checkEmailExists } = require("../services/customerService");
    const existingAccounts = await checkEmailExists(email);

    // As with find-phone: a customer only needs an existence signal here
    // (duplicate-email check on a candidate address). Don't leak other accounts'
    // details to a customer session; managers still get full data.
    if (req.customerPhone) {
      const existenceOnly = (existingAccounts || []).map(() => ({}));
      return res.success(existenceOnly, "Account List by Email Fetched Successfully");
    }

    res.success(existingAccounts, "Account List by Email Fetched Successfully");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const handleUpdatePhoneByAccountNumber = async (req, res) => {
  try {
    const { accountNumber, phone } = req.body;
    if (!accountNumber) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40002 },
      });
    }
    if (!phone) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }
    await assertAccountOwnedByCaller(accountNumber, req.customerPhone);
    const isPhoneUpadated = await updatePhoneByAccountNumber({
      accountNumber,
      newPhone: phone,
    });
    res.success({ isPhoneUpadated }, "Phone Upadated Request Successfull.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};
const handleUpdateEmailByAccountNumber = async (req, res) => {
  try {
    const { accountNumber, email } = req.body;
    if (!accountNumber) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40002 },
      });
    }
    if (!email) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40010 },
      });
    }
    await assertAccountOwnedByCaller(accountNumber, req.customerPhone);
    const isEmailUpadated = await updateEmailByAccountNumber({
      accountNumber,
      newEmail: email,
    });
    res.success({ isEmailUpadated }, "Email Upadated Request Successfull.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};
const handleUpdateAddressByAccountNumber = async (req, res) => {
  try {
    const { accountNumber, address } = req.body;
    if (!accountNumber) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40002 },
      });
    }
    if (!address) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40031 },
      });
    }
    await assertAccountOwnedByCaller(accountNumber, req.customerPhone);
    const isAddressUpadated = await updateAddressByAccountNumber({
      accountNumber,
      newAddress: address,
    });
    res.success({ isAddressUpadated }, "Address Upadated Request Successfull.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};
const handleGetCustomerInfoByAccountNb = async (req, res) => {
  try {
    const { accountNumber, phone } = req.body;
    if (!accountNumber) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40002 },
      });
    }
    const customer = await getCustomerInfoByAccountNumber(accountNumber, phone);
    if (!customer) {
      throw Object.assign(new Error(), {
        status: statusCodes.NOT_FOUND,
        error: { code: 40401 },
      });
    }
    // This returns full CBS account data (cards, loans, address) — verify the
    // account actually belongs to the OTP-verified caller so a valid session
    // can't be reused to pull an arbitrary account by guessing its number.
    const normalize = (n) => (n && !n.startsWith('0') ? `0${n}` : n);
    if (normalize(customer.mobileNumber) !== normalize(req.customerPhone)) {
      throw Object.assign(new Error(), {
        status: statusCodes.UNAUTHORIZED,
        error: { code: 40118 },
      });
    }
    res.success(customer, "Customer Deatils Fetch Successfully.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const getCustomerImageByPhoneController = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }
    const profileImage = await getCustomerImageByPhone(phone);
    res.success(profileImage, " profileImage by Phone Fetched Successfully");
  } catch (error) {
    if (isCbsUpstreamError(error)) {
      console.error(`⚠️ CBS profile image unavailable for ${req.body.phone}: ${error.message}`);
      return res.success({ profileImage: null, cbsUnavailable: true }, "Profile image unavailable — CBS not reachable");
    }
    errorResponseHandler(error, req, res);
  }
};

const checkVerificationStatusController = async (req, res) => {
  try {
    // Scope strictly to the OTP-verified caller — a customer may only check
    // their OWN verification status, never an arbitrary phone from the body
    // (prevents using a valid session to probe other customers).
    const phone = req.customerPhone;
    if (!phone) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }
    const verificationStatus = await checkVerificationStatus(phone);
    res.success(verificationStatus, "Verification status fetched successfully");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

module.exports = {
  createCustomerController,
  getAccountsListByPhoneController,
  handleUpdatePhoneByAccountNumber,
  handleUpdateEmailByAccountNumber,
  handleUpdateAddressByAccountNumber,
  handleGetCustomerInfoByAccountNb,
  getCustomerImageByPhoneController,
  checkVerificationStatusController,
  checkDuplicateEmailController
};
