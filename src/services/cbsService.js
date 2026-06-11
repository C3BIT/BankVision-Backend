/**
 * CBS Service — Single Adapter Layer
 *
 * ALL CBS (Core Banking System) API calls in the application go through
 * this file. When the bank delivers real CBS APIs, only this file needs
 * to change. The rest of the codebase (controllers, socket handlers,
 * customer service) stays untouched.
 *
 * TO INTEGRATE REAL CBS APIs:
 * 1. Create `cbsRealService.js` with the same exported function signatures
 * 2. Change the require below to point to `./cbsRealService`
 * 3. Done — no other files need to change
 *
 * Current implementation: mock (in-memory data, no real bank connection)
 */

const { EventEmitter } = require("events");
const cbs = require("./cbsRealService");

// ── CBS Log Emitter ────────────────────────────────────────────────────────────
// Socket handlers subscribe manager sockets to this emitter so every CBS
// API call/response is forwarded to the manager's browser console in real time.
const cbsLogEmitter = new EventEmitter();
cbsLogEmitter.setMaxListeners(50); // allow many concurrent manager connections

// ── Logging helper ─────────────────────────────────────────────────────────────
const cbsLog = (endpoint, args) => {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[CBS API CALL] ${endpoint}`);
  console.log(`  Timestamp : ${new Date().toISOString()}`);
  Object.entries(args).forEach(([key, val]) => {
    console.log(`  ${key.padEnd(14)}: ${JSON.stringify(val)}`);
  });
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
};

const wrap = (endpoint, fn, argNames) =>
  async (...args) => {
    const namedArgs = {};
    argNames.forEach((name, i) => { namedArgs[name] = args[i]; });
    cbsLog(endpoint, namedArgs);
    cbsLogEmitter.emit("cbs:call", { endpoint, args: namedArgs, timestamp: new Date().toISOString() });
    try {
      const result = await fn(...args);
      console.log(`[CBS API RESP] ${endpoint} →`, JSON.stringify(result, null, 2));
      cbsLogEmitter.emit("cbs:response", { endpoint, result, timestamp: new Date().toISOString() });
      return result;
    } catch (err) {
      console.error(`[CBS API ERR ] ${endpoint} → ${err.message}`);
      cbsLogEmitter.emit("cbs:error", { endpoint, error: err.message, timestamp: new Date().toISOString() });
      throw err;
    }
  };

// ── Wrapped exports ────────────────────────────────────────────────────────────

module.exports = {
  // Simulates: GET /cbs/api/v1/customer/lookup?phone=XXX
  lookupCustomerByPhone: wrap(
    "GET /cbs/api/v1/customer/lookup",
    cbs.lookupCustomerByPhone,
    ["phone"]
  ),

  // Simulates: GET /cbs/api/v1/customer/info?accountNumber=XXX
  getCustomerByAccountNumber: wrap(
    "GET /cbs/api/v1/customer/info",
    cbs.getCustomerByAccountNumber,
    ["accountNumber"]
  ),

  // Simulates: GET /cbs/api/v1/customer/accounts?phone=XXX
  getAccountsByPhone: wrap(
    "GET /cbs/api/v1/customer/accounts",
    cbs.getAccountsByPhone,
    ["phone"]
  ),

  // Simulates: GET /cbs/api/v1/customer/accounts/details?phone=XXX
  getAccountsWithDetails: wrap(
    "GET /cbs/api/v1/customer/accounts/details",
    cbs.getAccountsWithDetails,
    ["phone"]
  ),

  // Simulates: GET /cbs/api/v1/customer/cards?phone=XXX
  getCardsByPhone: wrap(
    "GET /cbs/api/v1/customer/cards",
    cbs.getCardsByPhone,
    ["phone"]
  ),

  // Simulates: GET /cbs/api/v1/customer/loans?phone=XXX
  getLoansByPhone: wrap(
    "GET /cbs/api/v1/customer/loans",
    cbs.getLoansByPhone,
    ["phone"]
  ),

  // Simulates: GET /cbs/api/v1/customer/check-email?email=XXX
  checkEmailExists: wrap(
    "GET /cbs/api/v1/customer/check-email",
    cbs.checkEmailExists,
    ["email"]
  ),

  // Simulates: POST /cbs/api/v1/otp/request
  requestOtp: wrap(
    "POST /cbs/api/v1/otp/request",
    cbs.requestOtp,
    ["requestType", "destination", "accountNumber"]
  ),

  // Simulates: POST /cbs/api/v1/otp/verify
  verifyOtp: wrap(
    "POST /cbs/api/v1/otp/verify",
    cbs.verifyOtp,
    ["requestId", "otp"]
  ),

  // Simulates: POST /cbs/api/v1/customer/phone/update
  updatePhone: wrap(
    "POST /cbs/api/v1/customer/phone/update",
    cbs.updatePhone,
    ["accountNumber", "requestId", "otp", "newPhone"]
  ),

  // Simulates: POST /cbs/api/v1/customer/email/update
  updateEmail: wrap(
    "POST /cbs/api/v1/customer/email/update",
    cbs.updateEmail,
    ["accountNumber", "requestId", "otp", "newEmail"]
  ),

  // Simulates: POST /cbs/api/v1/customer/address/update
  updateAddress: wrap(
    "POST /cbs/api/v1/customer/address/update",
    cbs.updateAddress,
    ["accountNumber", "requestId", "otp", "newAddress"]
  ),

  // Simulates: GET /cbs/api/v1/account/status?accountNumber=XXX
  getAccountStatus: wrap(
    "GET /cbs/api/v1/account/status",
    cbs.getAccountStatus,
    ["accountNumber"]
  ),

  // Simulates: POST /cbs/api/v1/account/activate
  activateAccount: wrap(
    "POST /cbs/api/v1/account/activate",
    cbs.activateAccount,
    ["accountNumber", "requestId", "otp", "nidNumber"]
  ),

  // Simulates: GET /cbs/api/v1/customer/photo?accountNumber=XXX
  getCustomerPhoto: wrap(
    "GET /cbs/api/v1/customer/photo",
    cbs.getCustomerPhoto,
    ["accountNumber"]
  ),

  // Simulates: GET /cbs/api/v1/customer/signature?accountNumber=XXX
  getCustomerSignature: wrap(
    "GET /cbs/api/v1/customer/signature",
    cbs.getCustomerSignature,
    ["accountNumber"]
  ),

  // CBS face identity matching
  getUserIdentity: wrap(
    "POST /cbs/api/v1/customer/identity",
    cbs.getUserIdentity,
    ["accountNumber", "imageBase64"]
  ),

  // ── Debug / Dev only ─────────────────────────────────────────────────────────
  getPendingRequest: cbs.getPendingRequest,

  REQUEST_TYPES: cbs.REQUEST_TYPES,

  // ── Real-time log forwarding ──────────────────────────────────────────────────
  // Socket handlers call this to pipe CBS logs to the connected manager's browser.
  cbsLogEmitter,
};
