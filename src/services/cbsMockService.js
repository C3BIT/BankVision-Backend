/**
 * CBS Mock Service
 * Simulates Core Banking System API middleware pattern
 *
 * In production, these would be actual API calls to the bank's CBS.
 * This mock simulates the middleware pattern where:
 * 1. Request is sent to CBS
 * 2. CBS sends OTP to customer's registered contact
 * 3. Customer inputs OTP in our UI
 * 4. We verify OTP via CBS API
 *
 * NOTE: This is MOCK data simulating bank's CBS database.
 * In production, replace with actual CBS API calls.
 */

const crypto = require("crypto");

// ============================================================
// MOCK CBS DATABASE - Simulates bank's customer data
// In production, this would come from actual CBS API calls
// ============================================================

// Mock Cards Data
const MOCK_CBS_CARDS = {
  "01819054224": [
    { cardNumber: "4532********1234", type: "Visa Debit Card", category: "Classic", status: "active", expiryDate: "12/2027" },
    { cardNumber: "5425********5678", type: "Mastercard Credit Card", category: "Platinum", status: "active", expiryDate: "06/2028" }
  ],
  "01886009771": [
    { cardNumber: "4916********9012", type: "Visa Credit Card", category: "Gold", status: "active", expiryDate: "03/2027" },
    { cardNumber: "3782********3456", type: "American Express", category: "Premium", status: "active", expiryDate: "09/2026" }
  ],
  "01911222952": [
    { cardNumber: "6011********7890", type: "Discover Card", category: "Silver", status: "active", expiryDate: "11/2028" }
  ],
  "01303393204": [
    { cardNumber: "4539********3204", type: "Visa Debit Card", category: "Classic", status: "active", expiryDate: "08/2027" }
  ],
  "01329282286": [
    { cardNumber: "4532********2286", type: "Visa Debit Card", category: "Classic", status: "active", expiryDate: "10/2027" }
  ]
};

// Mock Loans Data
const MOCK_CBS_LOANS = {
  "01819054224": [
    { loanNumber: "HL-2023-001234", type: "Home Loan", amount: "5,000,000 BDT", outstanding: "3,200,000 BDT", status: "active", installment: "45,000 BDT/month" },
    { loanNumber: "PL-2024-005678", type: "Personal Loan", amount: "500,000 BDT", outstanding: "180,000 BDT", status: "active", installment: "12,000 BDT/month" }
  ],
  "01886009771": [
    { loanNumber: "CL-2022-009012", type: "Car Loan", amount: "2,500,000 BDT", outstanding: "800,000 BDT", status: "active", installment: "35,000 BDT/month" }
  ],
  "01911222952": [
    { loanNumber: "BL-2023-003456", type: "Business Loan", amount: "10,000,000 BDT", outstanding: "7,500,000 BDT", status: "active", installment: "120,000 BDT/month" }
  ],
  "01303393204": [
    { loanNumber: "SL-2025-007890", type: "Student Loan", amount: "300,000 BDT", outstanding: "250,000 BDT", status: "active", installment: "8,000 BDT/month" }
  ],
  "01329282286": [
    { loanNumber: "SL-2025-008286", type: "Student Loan", amount: "250,000 BDT", outstanding: "200,000 BDT", status: "active", installment: "7,500 BDT/month" }
  ]
};

const MOCK_CBS_CUSTOMERS = {
  // Rizwan Riyad - Business Owner with multiple accounts, premium cards, and loans
  "01819054224": [
    {
      accountNumber: "1001200300401",
      mobileNumber: "01819054224",
      email: "rizwan.riyad@gmail.com",
      name: "Rizwan Riyad",
      address: "House 45, Road 12, Gulshan 2, Dhaka 1212",
      branch: "Gulshan 2 Branch",
      profileImage: "http://host.docker.internal:3000/uploads/profiles/rizwan_riyad.jpeg",
      nidNumber: "19901234567890123",
      dateOfBirth: "1990-05-15",
      accountStatus: "active",
      accountType: "Savings Account"
    },
    {
      accountNumber: "1001200300402",
      mobileNumber: "01819054224",
      email: "rizwan.riyad@gmail.com",
      name: "Rizwan Riyad",
      address: "House 45, Road 12, Gulshan 2, Dhaka 1212",
      branch: "Gulshan 2 Branch",
      profileImage: "http://host.docker.internal:3000/uploads/profiles/rizwan_riyad.jpeg",
      nidNumber: "19901234567890123",
      dateOfBirth: "1990-05-15",
      accountStatus: "active",
      accountType: "Current Account"
    }
  ],
  // Iftekhar Ucchash Ahmed - Professional with standard accounts and credit facilities
  "01886009771": [
    {
      accountNumber: "2001300400501",
      mobileNumber: "01886009771",
      email: "iftekhar.ucchash@gmail.com",
      name: "Iftekhar Ucchash Ahmed",
      address: "House 12, Road 8, Mirpur DOHS, Dhaka 1216",
      branch: "Mirpur DOHS Branch",
      profileImage: "http://host.docker.internal:3000/uploads/profiles/iftekhar_ucchash.png",
      nidNumber: "19881234567890456",
      dateOfBirth: "1988-03-20",
      accountStatus: "active",
      accountType: "Savings Account"
    },
    {
      accountNumber: "2001300400502",
      mobileNumber: "01886009771",
      email: "iftekhar.ucchash@gmail.com",
      name: "Iftekhar Ucchash Ahmed",
      address: "House 12, Road 8, Mirpur DOHS, Dhaka 1216",
      branch: "Mirpur DOHS Branch",
      profileImage: "http://host.docker.internal:3000/uploads/profiles/iftekhar_ucchash.png",
      nidNumber: "19881234567890456",
      dateOfBirth: "1988-03-20",
      accountStatus: "active",
      accountType: "Fixed Deposit"
    }
  ],
  // Zia Uddin Muhammad Tarek - Entrepreneur with business accounts and loan facilities
  "01911222952": [
    {
      accountNumber: "3001400500601",
      mobileNumber: "01911222952",
      email: "tarekraihan.bd@gmail.com",
      name: "Zia Uddin Muhammad Tarek",
      address: "House 32, Road 5, Dhanmondi, Dhaka 1205",
      branch: "Dhanmondi Branch",
      profileImage: "http://host.docker.internal:3000/uploads/profiles/tarek_raihan.png",
      nidNumber: "19851234567890789",
      dateOfBirth: "1985-08-12",
      accountStatus: "active",
      accountType: "Business Account"
    },
    {
      accountNumber: "3001400500602",
      mobileNumber: "01911222952",
      email: "tarekraihan.bd@gmail.com",
      name: "Zia Uddin Muhammad Tarek",
      address: "House 32, Road 5, Dhanmondi, Dhaka 1205",
      branch: "Dhanmondi Branch",
      profileImage: "http://host.docker.internal:3000/uploads/profiles/tarek_raihan.png",
      nidNumber: "19851234567890789",
      dateOfBirth: "1985-08-12",
      accountStatus: "active",
      accountType: "Savings Account"
    }
  ],
  // Nafiz Ahmed - Student with savings account and student loan
  "01303393204": [
    {
      accountNumber: "4001500600701",
      mobileNumber: "01303393204",
      email: "ahmednafiz2004@gmail.com",
      name: "Nafiz Ahmed",
      address: "Mirpur DOHS, Mirpur",
      branch: "Mirpur DOHS Branch",
      profileImage: "http://host.docker.internal:3000/uploads/profiles/nafiz_ahmed.png",
      nidNumber: "5117882927",
      dateOfBirth: "2004-01-15",
      accountStatus: "active",
      accountType: "Savings Account"
    }
  ],
  // Test Customer - Student with savings account and student loan
  "01835920068": [
    {
      accountNumber: "4001500600702",
      mobileNumber: "01835920068",
      email: "ahmednafiz2004@gmail.com",
      name: "Nafiz Ahmed",
      address: "Mirpur DOHS, Mirpur",
      branch: "Mirpur DOHS Branch",
      profileImage: "http://host.docker.internal:3000/uploads/profiles/nafiz_ahmed.png",
      nidNumber: "5117882927",
      dateOfBirth: "2004-01-15",
      accountStatus: "active",
      accountType: "Savings Account"
    }
  ]
};

// In-memory storage for pending requests (would be Redis in production)
const pendingRequests = new Map();

// In-memory storage for mock data updates (simulates CBS updates)
const mockDataUpdates = new Map();

// Request types
const REQUEST_TYPES = {
  PHONE_CHANGE: "phone_change",
  EMAIL_CHANGE: "email_change",
  ADDRESS_CHANGE: "address_change",
  ACCOUNT_ACTIVATION: "account_activation",
  IDENTITY_VERIFY: "identity_verify"
};

// Generate a mock request ID
const generateRequestId = () => {
  return `CBS_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
};

// Generate a mock OTP (6 digits)
const generateOtp = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * Get customer from mock CBS data (with any updates applied)
 */
const getMockCustomer = (accountNumber) => {
  // Check if there's an updated version
  if (mockDataUpdates.has(accountNumber)) {
    return mockDataUpdates.get(accountNumber);
  }

  // Search in original mock data
  for (const phone in MOCK_CBS_CUSTOMERS) {
    const accounts = MOCK_CBS_CUSTOMERS[phone];
    const customer = accounts.find(acc => acc.accountNumber === accountNumber);
    if (customer) {
      return { ...customer }; // Return a copy
    }
  }
  return null;
};

/**
 * Get all accounts by phone from mock CBS data
 */
const getMockAccountsByPhone = (phone) => {
  const accounts = MOCK_CBS_CUSTOMERS[phone] || [];

  // Also check for any updated phone numbers
  const updatedAccounts = [];
  for (const [accNum, data] of mockDataUpdates.entries()) {
    if (data.mobileNumber === phone) {
      updatedAccounts.push(data);
    }
  }

  // Merge original and updated, preferring updated
  const result = [...accounts];
  for (const updated of updatedAccounts) {
    const idx = result.findIndex(a => a.accountNumber === updated.accountNumber);
    if (idx >= 0) {
      result[idx] = updated;
    } else {
      result.push(updated);
    }
  }

  return result;
};

/**
 * Customer Lookup by Phone
 * Simulates: GET /cbs/api/v1/customer/lookup?phone=XXX
 */
const lookupCustomerByPhone = async (phone) => {
  try {
    console.log(`[CBS Mock] Looking up customer by phone: ${phone}`);

    const accounts = getMockAccountsByPhone(phone);

    if (accounts.length === 0) {
      return {
        found: false,
        message: "Customer not found in CBS"
      };
    }

    // Return first account's basic info (CBS typically returns primary account)
    const customer = accounts[0];
    return {
      found: true,
      accountNumber: customer.accountNumber,
      name: customer.name,
      email: customer.email,
      mobileNumber: customer.mobileNumber,
      address: customer.address,
      branch: customer.branch,
      profileImage: customer.profileImage,
      totalAccounts: accounts.length
    };
  } catch (error) {
    console.error("CBS Lookup Error:", error);
    throw new Error("CBS service unavailable");
  }
};

/**
 * Get all accounts for a phone number
 * Simulates: GET /cbs/api/v1/customer/accounts?phone=XXX
 */
const getAccountsByPhone = async (phone) => {
  try {
    console.log(`[CBS Mock] Getting accounts for phone: ${phone}`);

    const accounts = getMockAccountsByPhone(phone);

    return accounts.map(acc => ({
      accountNumber: acc.accountNumber,
      branch: acc.branch,
      accountStatus: acc.accountStatus || "active"
    }));
  } catch (error) {
    console.error("CBS Get Accounts Error:", error);
    throw new Error("CBS service unavailable");
  }
};

/**
 * Get customer info by account number
 * Simulates: GET /cbs/api/v1/customer/info?accountNumber=XXX
 */
const getCustomerByAccountNumber = async (accountNumber) => {
  try {
    console.log(`[CBS Mock] Getting customer info for account: ${accountNumber}`);

    const customer = getMockCustomer(accountNumber);

    if (!customer) {
      return null;
    }

    return {
      accountNumber: customer.accountNumber,
      name: customer.name,
      email: customer.email,
      mobileNumber: customer.mobileNumber,
      address: customer.address,
      branch: customer.branch,
      profileImage: customer.profileImage,
      nidNumber: customer.nidNumber,
      dateOfBirth: customer.dateOfBirth
    };
  } catch (error) {
    console.error("CBS Get Customer Error:", error);
    throw new Error("CBS service unavailable");
  }
};

/**
 * Request OTP for a service
 * Simulates: POST /cbs/api/v1/otp/request
 */
const requestOtp = async (accountNumber, type, destination, newValue = null) => {
  try {
    const customer = getMockCustomer(accountNumber);

    if (!customer) {
      throw new Error("Account not found in CBS");
    }

    const requestId = generateRequestId();
    const otp = generateOtp();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

    // Determine where to send OTP
    let sendTo;

    switch (destination) {
      case "phone":
      case "old_phone":
        sendTo = customer.mobileNumber;
        break;
      case "new_phone":
        sendTo = newValue;
        break;
      case "email":
      case "old_email":
        sendTo = customer.email;
        break;
      case "new_email":
        sendTo = newValue;
        break;
      default:
        throw new Error("Invalid destination");
    }

    // Store pending request
    pendingRequests.set(requestId, {
      accountNumber,
      type,
      destination,
      newValue,
      otp,
      expiresAt,
      verified: false,
      attempts: 0
    });

    // In production, CBS would send actual SMS/Email
    console.log(`[CBS Mock] OTP ${otp} sent to ${sendTo} for ${type}`);

    // Return without exposing OTP (just like real CBS)
    return {
      success: true,
      requestId,
      message: `OTP sent to ${destination === "new_phone" || destination === "new_email" ? "new contact" : "registered contact"}`,
      destination: sendTo.replace(/(.{3}).*(.{3})/, "$1***$2"), // Mask for security
      expiresIn: 300 // seconds
    };
  } catch (error) {
    console.error("CBS OTP Request Error:", error);
    throw error;
  }
};

/**
 * Verify OTP
 * Simulates: POST /cbs/api/v1/otp/verify
 */
const verifyOtp = async (requestId, otp) => {
  const request = pendingRequests.get(requestId);

  if (!request) {
    throw new Error("Invalid or expired request");
  }

  if (Date.now() > request.expiresAt) {
    pendingRequests.delete(requestId);
    throw new Error("OTP has expired");
  }

  if (request.attempts >= 3) {
    pendingRequests.delete(requestId);
    throw new Error("Maximum attempts exceeded");
  }

  request.attempts++;

  if (request.otp !== otp) {
    return {
      verified: false,
      message: "Invalid OTP",
      attemptsRemaining: 3 - request.attempts
    };
  }

  request.verified = true;

  // Determine next step based on request type
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

  return {
    verified: true,
    message: "OTP verified successfully",
    nextStep
  };
};

/**
 * Update Phone Number in CBS
 * Simulates: POST /cbs/api/v1/customer/phone/update
 */
const updatePhone = async (accountNumber, requestId, otp, newPhone) => {
  const verification = await verifyOtp(requestId, otp);

  if (!verification.verified) {
    return verification;
  }

  try {
    const customer = getMockCustomer(accountNumber);
    if (!customer) {
      throw new Error("Account not found");
    }

    // Update in mock data store
    customer.mobileNumber = newPhone;
    mockDataUpdates.set(accountNumber, customer);

    pendingRequests.delete(requestId);

    console.log(`[CBS Mock] Phone updated for ${accountNumber}: ${newPhone}`);

    return {
      success: true,
      message: "Phone number updated successfully in CBS",
      newPhone: newPhone.replace(/(.{3}).*(.{3})/, "$1***$2")
    };
  } catch (error) {
    console.error("CBS Update Phone Error:", error);
    throw error;
  }
};

/**
 * Update Email in CBS
 * Simulates: POST /cbs/api/v1/customer/email/update
 */
const updateEmail = async (accountNumber, requestId, otp, newEmail) => {
  const verification = await verifyOtp(requestId, otp);

  if (!verification.verified) {
    return verification;
  }

  try {
    const customer = getMockCustomer(accountNumber);
    if (!customer) {
      throw new Error("Account not found");
    }

    // Update in mock data store
    customer.email = newEmail;
    mockDataUpdates.set(accountNumber, customer);

    pendingRequests.delete(requestId);

    console.log(`[CBS Mock] Email updated for ${accountNumber}: ${newEmail}`);

    return {
      success: true,
      message: "Email updated successfully in CBS",
      newEmail: newEmail.replace(/(.{3}).*@/, "$1***@")
    };
  } catch (error) {
    console.error("CBS Update Email Error:", error);
    throw error;
  }
};

/**
 * Update Address in CBS
 * Simulates: POST /cbs/api/v1/customer/address/update
 */
const updateAddress = async (accountNumber, requestId, otp, newAddress, addressType = "present") => {
  const verification = await verifyOtp(requestId, otp);

  if (!verification.verified) {
    return verification;
  }

  try {
    const customer = getMockCustomer(accountNumber);
    if (!customer) {
      throw new Error("Account not found");
    }

    // Update in mock data store
    customer.address = newAddress;
    mockDataUpdates.set(accountNumber, customer);

    pendingRequests.delete(requestId);

    console.log(`[CBS Mock] Address updated for ${accountNumber}: ${newAddress}`);

    return {
      success: true,
      message: "Address updated successfully in CBS",
      addressType
    };
  } catch (error) {
    console.error("CBS Update Address Error:", error);
    throw error;
  }
};

/**
 * Check Account Status
 * Simulates: GET /cbs/api/v1/account/status?accountNumber=XXX
 */
const getAccountStatus = async (accountNumber) => {
  try {
    const customer = getMockCustomer(accountNumber);

    if (!customer) {
      throw new Error("Account not found in CBS");
    }

    return {
      accountNumber: customer.accountNumber,
      accountHolder: customer.name,
      status: customer.accountStatus || "active",
      lastActivity: new Date().toISOString(),
      canActivate: customer.accountStatus === "dormant",
      requiresNID: customer.accountStatus === "dormant"
    };
  } catch (error) {
    console.error("CBS Account Status Error:", error);
    throw error;
  }
};

/**
 * Activate Dormant Account
 * Simulates: POST /cbs/api/v1/account/activate
 */
const activateAccount = async (accountNumber, requestId, otp, nidNumber) => {
  const verification = await verifyOtp(requestId, otp);

  if (!verification.verified) {
    return verification;
  }

  if (!nidNumber || nidNumber.length < 10) {
    throw new Error("Invalid NID number");
  }

  try {
    const customer = getMockCustomer(accountNumber);
    if (!customer) {
      throw new Error("Account not found");
    }

    // Update status in mock data store
    customer.accountStatus = "active";
    mockDataUpdates.set(accountNumber, customer);

    pendingRequests.delete(requestId);

    console.log(`[CBS Mock] Account activated: ${accountNumber}`);

    return {
      success: true,
      message: "Account activated successfully",
      accountNumber,
      nidVerified: true,
      newStatus: "active"
    };
  } catch (error) {
    console.error("CBS Activate Account Error:", error);
    throw error;
  }
};

/**
 * Get Pending Request (for debugging/testing)
 */
const getPendingRequest = (requestId) => {
  const request = pendingRequests.get(requestId);
  if (!request) return null;

  return {
    requestId,
    type: request.type,
    destination: request.destination,
    expiresAt: request.expiresAt,
    verified: request.verified,
    // Only expose OTP in development mode
    otp: process.env.NODE_ENV === "development" ? request.otp : undefined
  };
};

/**
 * Clean up expired requests
 */
const cleanupExpiredRequests = () => {
  const now = Date.now();
  for (const [requestId, request] of pendingRequests.entries()) {
    if (now > request.expiresAt) {
      pendingRequests.delete(requestId);
    }
  }
};

// Run cleanup every 5 minutes
setInterval(cleanupExpiredRequests, 5 * 60 * 1000);

/**
 * Get all accounts with details for a phone number
 * Simulates: GET /cbs/api/v1/customer/accounts/details?phone=XXX
 */
const getAccountsWithDetails = async (phone) => {
  try {
    console.log(`[CBS Mock] Getting accounts with details for phone: ${phone}`);

    const accounts = getMockAccountsByPhone(phone);

    return accounts.map(acc => ({
      id: acc.accountNumber,
      accountNumber: acc.accountNumber,
      type: acc.accountType || "Savings Account",
      branch: acc.branch,
      accountStatus: acc.accountStatus || "active",
      balance: "Available on request" // Banks typically don't expose balance in video banking
    }));
  } catch (error) {
    console.error("CBS Get Accounts Details Error:", error);
    throw new Error("CBS service unavailable");
  }
};

/**
 * Get all cards for a phone number
 * Simulates: GET /cbs/api/v1/customer/cards?phone=XXX
 */
const getCardsByPhone = async (phone) => {
  try {
    console.log(`[CBS Mock] Getting cards for phone: ${phone}`);

    const cards = MOCK_CBS_CARDS[phone] || [];

    return cards.map(card => ({
      number: card.cardNumber,
      type: card.type,
      category: card.category,
      status: card.status,
      expiryDate: card.expiryDate
    }));
  } catch (error) {
    console.error("CBS Get Cards Error:", error);
    throw new Error("CBS service unavailable");
  }
};

/**
 * Get all loans for a phone number
 * Simulates: GET /cbs/api/v1/customer/loans?phone=XXX
 */
const getLoansByPhone = async (phone) => {
  try {
    console.log(`[CBS Mock] Getting loans for phone: ${phone}`);

    const loans = MOCK_CBS_LOANS[phone] || [];

    return loans.map(loan => ({
      number: loan.loanNumber,
      type: loan.type,
      category: `${loan.outstanding} outstanding`,
      amount: loan.amount,
      outstanding: loan.outstanding,
      installment: loan.installment,
      status: loan.status
    }));
  } catch (error) {
    console.error("CBS Get Loans Error:", error);
    throw new Error("CBS service unavailable");
  }
};

module.exports = {
  REQUEST_TYPES,
  MOCK_CBS_CUSTOMERS, // Exported for reference/debugging
  lookupCustomerByPhone,
  getAccountsByPhone,
  getAccountsWithDetails,
  getCardsByPhone,
  getLoansByPhone,
  getCustomerByAccountNumber,
  requestOtp,
  verifyOtp,
  updatePhone,
  updateEmail,
  updateAddress,
  getAccountStatus,
  activateAccount,
  getPendingRequest
};
