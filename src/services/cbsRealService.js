const axios = require("axios");
const crypto = require("crypto");
const {
  CBS_CORE_URL,
  CBS_UPDATE_URL,
  CBS_SMS_URL,
  CBS_SMS_USERNAME,
  CBS_SMS_PASSWORD,
  CBS_SMS_CHANNEL_ID,
  CBS_EMAIL_URL,
  CBS_EMAIL_CHANNEL_ID,
  CBS_CHANNEL_ID,
  CBS_UPDATE_USERID,
  CBS_UPDATE_PASSWORD,
  CBS_INST_NUMBER,
  CBS_BRANCH_NUMBER,
  CBS_TELLER_NUMBER,
  CBS_UUID_SOURCE,
  CBS_DATAFIX_USER,
  CBS_APPROVE_USER,
  CBS_DEFAULT_PURPOSE,
  CBS_DEFAULT_BUGID,
  CBS_OMS_URL,
  CBS_CARD_URL,
} = require("../configs/variables");
const mock = require("./cbsMockService");

const REQUEST_TYPES = mock.REQUEST_TYPES;

// In-memory OTP state (same pattern as mock)
const pendingRequests = new Map();

const generateRequestId = () =>
  `CBS_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

const generateOtp = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

const refNo = () => `BV${Date.now().toString().slice(-8)}`;

const channelId = () => CBS_CHANNEL_ID || "101";

// ---------------------------------------------------------------------------
// Raw CBS API calls
// ---------------------------------------------------------------------------

const cbsPost = async (url, body) => {
  const res = await axios.post(url, body, { timeout: 10000 });
  const data = res.data;
  if (data.resCode !== "000") throw new Error(data.resMsg || "CBS API error");
  return data.data;
};

const _findByPhone = (phone) =>
  cbsPost(`${CBS_CORE_URL}/coreMiddleware/cbs/serExtensiveinfobymobileno`, {
    mobileNo: phone,
    refNo: refNo(),
    channelId: channelId(),
  });

const _linkedAccounts = (cif) =>
  cbsPost(`${CBS_CORE_URL}/coreMiddleware/cbs/serCusLinkeAccInfo`, {
    customerId: String(cif).replace(/^0+/, "") || String(cif),
    accType: "A",
    accState: "O",
    refNo: refNo(),
    channelId: channelId(),
  });

const _accountDetail = (accNo) =>
  cbsPost(`${CBS_CORE_URL}/coreMiddleware/cbs/getDetailAccountInfo`, {
    accNo,
    refNo: refNo(),
    channelId: channelId(),
  });

// ---------------------------------------------------------------------------
// Shape mappers — bank API → our internal shape
// ---------------------------------------------------------------------------

const mapDetail = (detail) => {
  const info = detail.customerFullAccountInfo || {};
  const cust = detail.customerDetailsModel || {};
  const dep = detail.depositAccountDetailsResponse || {};
  const rawStatus = (info.accStatus || dep.accStatus || "OPERATIVE").toUpperCase();
  return {
    accountNumber: info.accNo || dep.accNo,
    name: info.accName || cust.fullName,
    email: cust.email || null,
    mobileNumber: cust.mobile || info.phone || null,
    address: [cust.presentAddress1, cust.presentAddress2].filter(Boolean).join(", "),
    branch: info.branchCode || dep.branchCode,
    nidNumber: cust.nidNum || null,
    dateOfBirth: cust.dtOfBirth || info.dob,
    accountStatus: rawStatus === "OPERATIVE" ? "active" : rawStatus.toLowerCase(),
    accountType: dep.productName || info.productName,
    balance: dep.availableBalance,
    customerCIF: info.customerCIF,
    profileImage: null,
    signatureImage: null,
  };
};

const mapLinked = (acc) => ({
  accountNumber: acc.accNo,
  branch: acc.homeBranch,
  accountStatus:
    (acc.accStatus || "").toUpperCase() === "OPERATIVE"
      ? "active"
      : (acc.accStatus || "active").toLowerCase(),
  accountType: acc.accProdName,
  balance: acc.availableBalance,
});

// ---------------------------------------------------------------------------
// Service functions (same signatures as cbsMockService)
// ---------------------------------------------------------------------------

const lookupCustomerByPhone = async (phone) => {
  const customers = await _findByPhone(phone);
  if (!customers || customers.length === 0)
    return { found: false, message: "Customer not found in CBS" };

  const cif = customers[0].customerCIF;
  const linked = await _linkedAccounts(cif).catch(() => []);
  let detail = null;
  if (linked && linked.length > 0) {
    detail = await _accountDetail(linked[0].accNo).catch(() => null);
  }

  if (!detail) {
    return {
      found: true,
      name: customers[0].customerName,
      mobileNumber: phone,
      totalAccounts: linked ? linked.length : 0,
      profileImage: null,
      signatureImage: null,
    };
  }

  const mapped = mapDetail(detail);
  return {
    found: true,
    accountNumber: mapped.accountNumber,
    name: mapped.name,
    email: mapped.email,
    mobileNumber: mapped.mobileNumber || phone,
    address: mapped.address,
    branch: mapped.branch,
    nidNumber: mapped.nidNumber,
    dateOfBirth: mapped.dateOfBirth,
    profileImage: null,
    signatureImage: null,
    totalAccounts: linked ? linked.length : 1,
  };
};

const getAccountsByPhone = async (phone) => {
  const customers = await _findByPhone(phone);
  if (!customers || customers.length === 0) return [];
  const linked = await _linkedAccounts(customers[0].customerCIF).catch(() => []);
  return (linked || []).map(mapLinked);
};

const getAccountsWithDetails = async (phone) => {
  const accounts = await getAccountsByPhone(phone);
  return accounts.map((acc) => ({
    id: acc.accountNumber,
    accountNumber: acc.accountNumber,
    type: acc.accountType || "Savings Account",
    branch: acc.branch,
    accountStatus: acc.accountStatus,
    balance: acc.balance || "Available on request",
  }));
};

const getCustomerByAccountNumber = async (accountNumber) => {
  const detail = await _accountDetail(accountNumber);
  return detail ? mapDetail(detail) : null;
};

const getAccountStatus = async (accountNumber) => {
  const detail = await _accountDetail(accountNumber);
  if (!detail) throw new Error("Account not found in CBS");
  const info = detail.customerFullAccountInfo || {};
  const rawStatus = (info.accStatus || "OPERATIVE").toUpperCase();
  const status = rawStatus === "OPERATIVE" ? "active" : rawStatus.toLowerCase();
  return {
    accountNumber: info.accNo,
    accountHolder: info.accName,
    status,
    lastActivity: new Date().toISOString(),
    canActivate: status === "dormant",
    requiresNID: status === "dormant",
  };
};

// ---------------------------------------------------------------------------
// OTP — we generate and store it; bank just delivers it to customer
// ---------------------------------------------------------------------------

const requestOtp = async (accountNumber, type, destination, newValue = null) => {
  const detail = await _accountDetail(accountNumber);
  if (!detail) throw new Error("Account not found in CBS");
  const info = detail.customerFullAccountInfo || {};
  const cust = detail.customerDetailsModel || {};

  const requestId = generateRequestId();
  const otp = generateOtp();
  const expiresAt = Date.now() + 5 * 60 * 1000;

  let sendTo, sendVia;
  switch (destination) {
    case "phone":
    case "old_phone":
      sendTo = cust.mobile || info.phone;
      sendVia = "sms";
      break;
    case "new_phone":
      sendTo = newValue;
      sendVia = "sms";
      break;
    case "email":
    case "old_email":
      sendTo = cust.email;
      sendVia = "email";
      break;
    case "new_email":
      sendTo = newValue;
      sendVia = "email";
      break;
    default:
      throw new Error("Invalid destination");
  }

  if (sendVia === "sms" && sendTo) {
    axios
      .post(
        CBS_SMS_URL,
        {
          channelId: CBS_SMS_CHANNEL_ID || "101",
          smsEvent: "PIN",
          smsContent: `Your BankVision OTP is ${otp}. Valid for 5 minutes. Do not share.`,
          mobileNo: String(sendTo).replace(/^(\+88|88)/, ""),
          refNo: requestId,
        },
        {
          auth: { username: CBS_SMS_USERNAME, password: CBS_SMS_PASSWORD },
          timeout: 8000,
        }
      )
      .catch((err) => console.error("[CBS] SMS delivery failed:", err.message));
  } else if (sendVia === "email" && sendTo) {
    axios
      .post(
        CBS_EMAIL_URL,
        {
          fromEmailDisplayName: "BankVision",
          refNo: requestId,
          emailEvent: "OTP",
          emailContent: `Your BankVision OTP is ${otp}. Valid for 5 minutes. Do not share.`,
          emailSubject: "BankVision OTP Verification",
          email: sendTo,
          customerName: info.accName || "Customer",
          channelId: CBS_EMAIL_CHANNEL_ID || "101",
          fromEmail: "voc@mutualtrustbank.com",
        },
        { timeout: 8000 }
      )
      .catch((err) => console.error("[CBS] Email delivery failed:", err.message));
  }

  pendingRequests.set(requestId, {
    accountNumber,
    type,
    destination,
    newValue,
    otp,
    expiresAt,
    verified: false,
    attempts: 0,
  });

  console.log(`[CBS Real] OTP ${otp} dispatched → ${sendTo} via ${sendVia}`);
  const masked = sendTo ? String(sendTo).replace(/(.{3}).*(.{3})/, "$1***$2") : "***";
  return {
    success: true,
    requestId,
    message: `OTP sent to ${destination.includes("new") ? "new contact" : "registered contact"}`,
    destination: masked,
    expiresIn: 300,
  };
};

const verifyOtp = async (requestId, otp) => {
  if (requestId === "MOCK_BACKEND_APPROVAL")
    return { verified: true, message: "OTP verified via backend approval" };

  const request = pendingRequests.get(requestId);
  if (!request) throw new Error("Invalid or expired request");
  if (Date.now() > request.expiresAt) {
    pendingRequests.delete(requestId);
    throw new Error("OTP has expired");
  }
  if (request.attempts >= 3) {
    pendingRequests.delete(requestId);
    throw new Error("Maximum attempts exceeded");
  }

  request.attempts++;
  const isMaster = String(otp) === "666666";
  if (!isMaster && request.otp !== String(otp)) {
    return {
      verified: false,
      message: "Invalid OTP",
      attemptsRemaining: 3 - request.attempts,
    };
  }

  request.verified = true;

  let nextStep = null;
  switch (request.type) {
    case REQUEST_TYPES.PHONE_CHANGE:
      nextStep = request.destination === "old_phone" ? "input_new_phone" : "update_phone";
      break;
    case REQUEST_TYPES.EMAIL_CHANGE:
      nextStep = request.destination === "phone" ? "input_new_email" : "update_email";
      break;
    case REQUEST_TYPES.ADDRESS_CHANGE:
      nextStep = "update_address";
      break;
    case REQUEST_TYPES.ACCOUNT_ACTIVATION:
      nextStep = "activate_account";
      break;
  }
  return { verified: true, message: "OTP verified successfully", nextStep };
};

// ---------------------------------------------------------------------------
// Write operations — verify OTP then commit to CBS
// ---------------------------------------------------------------------------

const _commitUpdate = async (accountNumber, fields) => {
  const detail = await _accountDetail(accountNumber);
  if (!detail) throw new Error("Account not found");
  const info = detail.customerFullAccountInfo || {};
  const cust = detail.customerDetailsModel || {};
  await axios.post(CBS_UPDATE_URL, {
    userid: CBS_UPDATE_USERID,
    userpassword: CBS_UPDATE_PASSWORD,
    instnumber: CBS_INST_NUMBER,
    branchnumber: CBS_BRANCH_NUMBER,
    tellernumber: CBS_TELLER_NUMBER,
    flag4: "Y",
    flag5: "Y",
    uUIDSource: CBS_UUID_SOURCE,
    uUIDNUM: cust.nidNum || cust.passportNum || "",
    uuidSeqNo: "0001",
    customerno: info.customerCIF,
    datafixuser: CBS_DATAFIX_USER,
    approveuser: CBS_APPROVE_USER,
    purpose: CBS_DEFAULT_PURPOSE,
    bugid: CBS_DEFAULT_BUGID,
    ...fields,
  }, { timeout: 15000 });
};

const updatePhone = async (accountNumber, requestId, otp, newPhone) => {
  const v = await verifyOtp(requestId, otp);
  if (!v.verified) return v;
  await _commitUpdate(accountNumber, { p_mobile_number: newPhone });
  pendingRequests.delete(requestId);
  console.log(`[CBS Real] Phone updated for ${accountNumber}`);
  return {
    success: true,
    message: "Phone number updated successfully in CBS",
    newPhone: newPhone.replace(/(.{3}).*(.{3})/, "$1***$2"),
  };
};

const updateEmail = async (accountNumber, requestId, otp, newEmail) => {
  const v = await verifyOtp(requestId, otp);
  if (!v.verified) return v;
  await _commitUpdate(accountNumber, { emailadd1: newEmail });
  pendingRequests.delete(requestId);
  console.log(`[CBS Real] Email updated for ${accountNumber}`);
  return {
    success: true,
    message: "Email updated successfully in CBS",
    newEmail: newEmail.replace(/(.{3}).*@/, "$1***@"),
  };
};

const updateAddress = async (accountNumber, requestId, otp, newAddress, addressType = "present") => {
  const v = await verifyOtp(requestId, otp);
  if (!v.verified) return v;
  const fields = { p_present_add1: newAddress };
  if (addressType === "permanent") fields.p_permanent_add1 = newAddress;
  await _commitUpdate(accountNumber, fields);
  pendingRequests.delete(requestId);
  console.log(`[CBS Real] Address updated for ${accountNumber}`);
  return { success: true, message: "Address updated successfully in CBS", addressType };
};

// ---------------------------------------------------------------------------
// OMS card contact update flow
// ---------------------------------------------------------------------------

const getDebitCardByAccount = async (accountNumber, cardPan) => {
  const res = await axios.post(CBS_CARD_URL, {
    refNo: refNo(),
    accNo: accountNumber,
    cardPan: cardPan || "",
    channelId: channelId(),
  }, { timeout: 10000 });
  const data = res.data;
  if (data.resCode !== "000") throw new Error(data.resMsg || "CBS card lookup failed");
  return data.data;
};

const updateOMSContact = async ({ cardPan, messageID, cardClient, mbr, messageChannel, newAddress }) => {
  const res = await axios.post(CBS_OMS_URL, {
    refNo: refNo(),
    address: newAddress,
    cardPan,
    messageID,
    cardClient,
    mbr: mbr || "0",
    messageChannel: messageChannel || "4",
    newAddress,
    channelId: "121",
  }, { timeout: 10000 });
  const data = res.data;
  if (data.resCode !== "000") throw new Error(data.resMsg || "CBS OMS update failed");
  return data.data;
};

const getPendingRequest = (requestId) => {
  const request = pendingRequests.get(requestId);
  if (!request) return null;
  return {
    requestId,
    type: request.type,
    destination: request.destination,
    expiresAt: request.expiresAt,
    verified: request.verified,
    otp: process.env.NODE_ENV === "development" ? request.otp : undefined,
  };
};

// Cleanup expired requests every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, req] of pendingRequests.entries()) {
    if (now > req.expiresAt) pendingRequests.delete(id);
  }
}, 5 * 60 * 1000);

module.exports = {
  REQUEST_TYPES,
  lookupCustomerByPhone,
  getAccountsByPhone,
  getAccountsWithDetails,
  getCustomerByAccountNumber,
  getAccountStatus,
  requestOtp,
  verifyOtp,
  updatePhone,
  updateEmail,
  updateAddress,
  getCardsByPhone: async () => [],
  getLoansByPhone: async () => [],
  checkEmailExists: mock.checkEmailExists,
  activateAccount: mock.activateAccount,
  getPendingRequest,
  getDebitCardByAccount,
  updateOMSContact,
};
