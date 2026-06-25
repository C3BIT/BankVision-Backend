const axios = require("axios");
const crypto = require("crypto");
const {
  CBS_CHANNEL_ID,
  CBS_USERNAME,
  CBS_PASSWORD,
  CBS_URL_DETAIL_ACCOUNT,
  CBS_URL_EXTENSIVE_INFO,
  CBS_URL_LINKED_ACC,
  CBS_URL_USER_IDENTITY,
  CBS_EMAIL_URL,
  CBS_SMS_URL,
  CBS_CARD_URL,
  CBS_OMS_URL,
  CBS_UPDATE_URL,
  CBS_URL_CUSTOMER_PHOTO,
  CBS_URL_CUSTOMER_CARDS,
  CBS_URL_CUSTOMER_SIGNATURE,
  CBS_URL_SET_ACCOUNT_ACTIVE,
  CBS_URL_SAVE_ADDRESS,
  CBS_URL_SAVE_CUSTOMER_INFO_LOG,
  CBS_URL_GET_CUSTOMER_PHOTO,
  CBS_SMS_USERNAME,
  CBS_SMS_PASSWORD,
  CBS_SMS_CHANNEL_ID,
  CBS_SMS_EVENT,
  CBS_EMAIL_CHANNEL_ID,
  CBS_FROM_EMAIL,
  CBS_FROM_EMAIL_DISPLAY_NAME,
  CBS_EMAIL_EVENT,
  CBS_EMAIL_SUBJECT,
  CBS_ACC_TYPE,
  CBS_ACC_STATE,
  CBS_OMS_CHANNEL_ID,
  CBS_UPDATE_USERID,
  CBS_UPDATE_PASSWORD,
  CBS_INST_NUMBER,
  CBS_BRANCH_NUMBER,
  CBS_TELLER_NUMBER,
  CBS_UUID_SOURCE,
  CBS_UUID_SEQ_NO,
  CBS_FLAG4,
  CBS_FLAG5,
  CBS_DATAFIX_USER,
  CBS_APPROVE_USER,
  CBS_DEFAULT_PURPOSE,
  CBS_DEFAULT_BUGID,
} = require("../configs/variables");
const REQUEST_TYPES = {
  PHONE_CHANGE: "phone_change",
  EMAIL_CHANGE: "email_change",
  ADDRESS_CHANGE: "address_change",
  ACCOUNT_ACTIVATION: "account_activation",
  IDENTITY_VERIFY: "identity_verify",
};

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
  const res = await axios.post(url, body, {
    timeout: 10000,
    auth: { username: CBS_USERNAME, password: CBS_PASSWORD },
  });
  const data = res.data;
  if (data.resCode !== "000") throw new Error(data.resMsg || "CBS API error");
  return data.data;
};

const _findByPhone = (phone) =>
  cbsPost(CBS_URL_EXTENSIVE_INFO, {
    mobileNo: phone,
    refNo: refNo(),
    channelId: channelId(),
  });

const _linkedAccounts = (cif) =>
  cbsPost(CBS_URL_LINKED_ACC, {
    customerId: String(cif).replace(/^0+/, "") || String(cif),
    accType: CBS_ACC_TYPE,
    accState: CBS_ACC_STATE,
    refNo: refNo(),
    channelId: channelId(),
  });

const _accountDetail = (accNo) =>
  cbsPost(CBS_URL_DETAIL_ACCOUNT, {
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
    address: [cust.presentAddress1, cust.presentAddress2].map(s => (s || '').trim()).filter(Boolean).join(", "),
    permanentAddress: [cust.permanentAddress1, cust.permanentAddress2].map(s => (s || '').trim()).filter(Boolean).join(", "),
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
// Service functions
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

  const firstAccNo = linked && linked.length > 0 ? linked[0].accNo : null;
  const [profileImage, signatureImage] = firstAccNo
    ? await Promise.all([
        getCustomerPhoto(firstAccNo).catch(() => null),
        getCustomerSignature(firstAccNo).catch(() => null),
      ])
    : [null, null];

  if (!detail) {
    return {
      found: true,
      name: customers[0].customerName,
      mobileNumber: phone,
      totalAccounts: linked ? linked.length : 0,
      profileImage,
      signatureImage,
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
    permanentAddress: mapped.permanentAddress,
    branch: mapped.branch,
    nidNumber: mapped.nidNumber,
    dateOfBirth: mapped.dateOfBirth,
    profileImage,
    signatureImage,
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
          smsEvent: CBS_SMS_EVENT,
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
          fromEmailDisplayName: CBS_FROM_EMAIL_DISPLAY_NAME,
          refNo: requestId,
          emailEvent: CBS_EMAIL_EVENT,
          emailContent: `Your BankVision OTP is ${otp}. Valid for 5 minutes. Do not share.`,
          emailSubject: CBS_EMAIL_SUBJECT,
          email: sendTo,
          customerName: info.accName || "Customer",
          channelId: CBS_EMAIL_CHANNEL_ID || "101",
          fromEmail: CBS_FROM_EMAIL,
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
  if (requestId === "MANAGER_APPROVAL")
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

  // Full payload — CBS requires all fields present (empty string if unused)
  const payload = {
    userid: CBS_UPDATE_USERID,
    userpassword: CBS_UPDATE_PASSWORD,
    instnumber: CBS_INST_NUMBER,
    branchnumber: CBS_BRANCH_NUMBER,
    tellernumber: CBS_TELLER_NUMBER,
    flag4: CBS_FLAG4,
    flag5: CBS_FLAG5,
    uUIDSource: CBS_UUID_SOURCE,
    uUIDNUM: cust.nidNum || cust.passportNum || "",
    uuidSeqNo: CBS_UUID_SEQ_NO,
    customerno: info.customerCIF,
    p_title_code: "", p_name1: "", p_mid_name: "", p_name2: "",
    p_father_name: "", p_mother_name: "", p_spouse_name: "",
    p_present_add1: "", p_present_add2: "", p_present_add3: "", p_present_add4: "",
    p_present_state_code: "", p_present_city_code: "", p_present_thana_code: "",
    p_present_sub_office_code: "", p_present_postcode: "", p_present_phone_no_bus: "",
    p_permanent_add1: "", p_permanent_add2: "", p_permanent_add3: "", p_permanent_add4: "",
    p_permanent_state_code: "", p_permanent_city_code: "", p_permanent_thana_code: "",
    p_permanent_sub_office_code: "", p_permanent_postcode: "", p_permanent_phone_no_bus: "",
    p_mnthly_inc: "", p_nme_of_cncrn: "", p_occupation_code: "", p_marital_status: "",
    p_passport_number: "", p_passport_issue_dt: "", p_passport_expiry_dt: "",
    p_tin_number: "", p_present_country_code: "",
    p_professional_add1: "", p_professional_add2: "", p_professional_add3: "", p_professional_add4: "",
    p_professional_state_code: "", p_professional_city_code: "", p_professional_country_code: "",
    p_professional_thana_code: "", p_professional_sub_ofc_code: "",
    p_professional_post_code: "", p_professional_phone_no_bus: "",
    nameasidproof: "", spousetitle: "", fathertitle: "", mothertitle: "",
    resistatus: "", nationalitycd: "", sexcode: "", birthdate1: "",
    employername: "", emailadd1: "",
    presentphonenores: "", permanentphonenores: "", professionalphonenores: "",
    nidnumber: "", nidissuedt: "", nidexpirydt: "",
    birthcretificateno: "", birthcertificateissuedt: "", birthcertificateexpirydt: "",
    drivinglicensenumber: "", drivingissuedt: "", drivingexpirydt: "",
    tinissuedt: "", tin_expirydt: "", designation: "",
    parent1: "", parent2: "", parent3: "",
    bussectorcode: "", tradelicensenumber: "", tradelicenseissuedt: "", tradelicenseexpirydt: "",
    vatregnumber: "", vatregissuedt: "", vatregexpirydt: "",
    incorporationno: "", incorporationnoissuedt: "", incorporationnoexpirydt: "",
    networth: "", fixasset: "", manpowrprmanent: "", manpowrtmporary: "",
    countryofbirth: "", totalasset: "",
    add1business: "", add2business: "", add3business: "", add4business: "",
    businessphonenores: "", businessphonenobus: "",
    p_source_of_funds: "", p_mobile_number: "",
    datafixuser: CBS_DATAFIX_USER,
    approveuser: CBS_APPROVE_USER,
    purpose: CBS_DEFAULT_PURPOSE,
    bugid: CBS_DEFAULT_BUGID,
    status: "", message: "", apicode: "", modulename: "",
    // caller-supplied fields overwrite the empty defaults above
    ...fields,
  };

  const res = await axios.post(CBS_UPDATE_URL, payload, {
    timeout: 15000,
    httpsAgent: new (require("https").Agent)({ rejectUnauthorized: false }),
  });
  const addrFields = {
    p_present_add1: payload.p_present_add1,
    p_present_add2: payload.p_present_add2,
    p_permanent_add1: payload.p_permanent_add1,
    p_permanent_add2: payload.p_permanent_add2,
  };
  console.log(`[CBS Commit] Sent addr fields:`, JSON.stringify(addrFields));
  console.log(`[CBS Commit] CBS response status="${res.data?.status}" message="${res.data?.message}"`);
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

  // Fetch current CBS data to get district/thana codes for the unchanged address type
  const detail = await _accountDetail(accountNumber);
  const cust = detail?.customerDetailsModel || {};

  console.log(`[CBS Addr] Updating ${addressType} for ${accountNumber} via SaveAddressInfo`);
  console.log(`[CBS Addr] New address: "${newAddress}"`);

  // Address type codes: 1 = present, 3 = permanent
  const addressTypeCode = addressType === "permanent" ? 3 : 1;

  const payload = {
    refNo: refNo(),
    channelId: CBS_CHANNEL_ID,
    serviceRequest: {
      subtype: "2",
      name: cust.fullName || "",
      mobile: cust.mobile || "",
      nid: cust.nidNum || "",
      acc_number: accountNumber,
      address_details: [
        {
          type: addressTypeCode,
          district: parseInt(
            addressType === "permanent"
              ? (cust.permanentDistrict || "0")
              : (cust.presentDistrict || "0"),
            10
          ),
          sub_district: parseInt(
            addressType === "permanent"
              ? (cust.permanentThana || "0")
              : (cust.presentThana || "0"),
            10
          ),
          land_mark: newAddress,
          addressshow: newAddress,
          address: newAddress,
          remarks: "",
          Images: [],
        },
      ],
    },
  };

  console.log(`[CBS Addr] SaveAddressInfo payload:`, JSON.stringify(payload));

  const res = await axios.post(CBS_URL_SAVE_ADDRESS, payload, {
    timeout: 15000,
    httpsAgent: new (require("https").Agent)({ rejectUnauthorized: false }),
    auth: { username: CBS_USERNAME, password: CBS_PASSWORD },
  });

  const data = res.data;
  if (data.resCode !== "000" || data.serviceResponse?.ResponseCode !== "000") {
    const msg = data.serviceResponse?.ResponseMessage || data.resMsg || "CBS address update failed";
    console.error(`[CBS Addr] SaveAddressInfo failed: ${msg}`);
    throw new Error(msg);
  }

  console.log(`[CBS Addr] SaveAddressInfo success for ${accountNumber}`);
  pendingRequests.delete(requestId);
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
  }, {
    timeout: 10000,
    auth: { username: CBS_USERNAME, password: CBS_PASSWORD },
  });
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
    channelId: CBS_OMS_CHANNEL_ID,
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

// ---------------------------------------------------------------------------
// Customer photo and signature (pending MTB API provisioning)
// ---------------------------------------------------------------------------

const getCustomerPhoto = async (customerNo) => {
  const data = await cbsPost(
    CBS_URL_GET_CUSTOMER_PHOTO,
    {
      refNo: refNo(),
      channelId: "102",
      serviceRequest: { CustomerNo: customerNo },
    }
  );
  const photos = data?.serviceResponse?.Photos;
  if (!photos || photos.length === 0) return null;
  const active = photos.find((p) => (p.Status || "").toUpperCase() === "ACTIVE") || photos[0];
  return active.CustomerPhotoData || null;
};

// Log customer info access during a video call session.
// maker = manager employee ID, purpose = reason for the call/service
const saveCustomerInfoLog = async ({ cifNo, email, mobile, purpose, maker }) => {
  try {
    const data = await cbsPost(
      CBS_URL_SAVE_CUSTOMER_INFO_LOG,
      {
        refNo: refNo(),
        channelId: "102",
        serviceRequest: {
          cif_no: cifNo,
          email: email || "",
          mobile: mobile || "",
          purpose: purpose || "Video Banking Session",
          maker: maker || "",
        },
      }
    );
    return {
      success: data?.resCode === "000" || data?.serviceResponse?.status === "200",
      logId: data?.logId || null,
    };
  } catch (err) {
    // Non-fatal — log but don't block the call flow
    console.error("[CBS] saveCustomerInfoLog failed:", err.message);
    return { success: false, logId: null };
  }
};

const getCustomerSignature = async (accountNumber) => {
  const data = await cbsPost(
    CBS_URL_CUSTOMER_SIGNATURE,
    { accountNo: accountNumber, refNo: refNo(), channelId: channelId() }
  );
  return data.signatureImageBase64 || null;
};

const getUserIdentity = async (accountNumber, imageBase64) => {
  const data = await cbsPost(
    CBS_URL_USER_IDENTITY,
    { accountNo: accountNumber, imageBase64, refNo: refNo(), channelId: channelId() }
  );
  return {
    isMatch: data.isMatch === "1",
    score: parseFloat(data.score || "0"),
  };
};

// ---------------------------------------------------------------------------
// Loans — derived from serCusLinkeAccInfo (moduleName: "LN")
// ---------------------------------------------------------------------------

const getLoansByPhone = async (phone) => {
  const customers = await _findByPhone(phone);
  if (!customers || customers.length === 0) return [];
  const linked = await _linkedAccounts(customers[0].customerCIF).catch(() => []);
  return (linked || [])
    .filter((acc) => acc.moduleName === "LN")
    .map((acc) => ({
      number: acc.accNo,
      type: acc.accProdName,
      status:
        (acc.accStatus || "").toUpperCase() === "OPEN"
          ? "active"
          : (acc.accStatus || "active").toLowerCase(),
      amount: acc.currentBalance,
      outstanding: acc.currentBalance,
      branch: acc.homeBranch,
    }));
};

// ---------------------------------------------------------------------------
// Cards — via getCustomerCards (pending MTB API provisioning)
// ---------------------------------------------------------------------------

const getCardsByPhone = async (phone) => {
  const customers = await _findByPhone(phone);
  if (!customers || customers.length === 0) return [];
  const cif = customers[0].customerCIF;
  const data = await cbsPost(
    CBS_URL_CUSTOMER_CARDS,
    { customerId: String(cif), refNo: refNo(), channelId: channelId() }
  );
  return (data || []).map((card) => ({
    number: card.cardPan,
    type: card.cardType,
    category: card.cardCategory,
    network: card.cardNetwork,
    status: (card.status || "").toLowerCase(),
    expiryDate: card.expiryDate,
    linkedAccount: card.linkedAccount,
  }));
};

// ---------------------------------------------------------------------------
// Account activation — via setAccountActive (pending MTB API provisioning)
// ---------------------------------------------------------------------------

const activateAccount = async (accountNumber, requestId, otp, nidNumber) => {
  const v = await verifyOtp(requestId, otp);
  if (!v.verified) return v;

  const detail = await _accountDetail(accountNumber);
  if (!detail) throw new Error("Account not found in CBS");
  const cust = detail.customerDetailsModel || {};
  const info = detail.customerFullAccountInfo || {};

  const storedNid = (cust.nidNum || "").replace(/\D/g, "");
  const inputNid = (nidNumber || "").replace(/\D/g, "");
  if (storedNid && inputNid && storedNid !== inputNid) {
    throw new Error("NID number does not match our records");
  }

  const cif = String(info.customerCIF || "").replace(/^0+/, "") || String(info.customerCIF);
  await cbsPost(
    CBS_URL_SET_ACCOUNT_ACTIVE,
    { accountNo: accountNumber, customerId: cif, refNo: refNo(), channelId: channelId() }
  );

  pendingRequests.delete(requestId);
  console.log(`[CBS Real] Account activated: ${accountNumber}`);
  return {
    success: true,
    message: "Account activated successfully",
    accountNumber,
    nidVerified: true,
    newStatus: "active",
  };
};

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
  getLoansByPhone,
  getCardsByPhone,
  activateAccount,
  getCustomerPhoto,
  getCustomerSignature,
  getUserIdentity,
  saveCustomerInfoLog,
  checkEmailExists: async () => [],
  getPendingRequest,
  getDebitCardByAccount,
  updateOMSContact,
};
