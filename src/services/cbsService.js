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

const cbs = require("./cbsMockService");

module.exports = {
  // ── Customer Lookup ────────────────────────────────────────────────────────
  // Simulates: GET /cbs/api/v1/customer/lookup?phone=XXX
  lookupCustomerByPhone:       cbs.lookupCustomerByPhone,

  // Simulates: GET /cbs/api/v1/customer/info?accountNumber=XXX
  getCustomerByAccountNumber:  cbs.getCustomerByAccountNumber,

  // Simulates: GET /cbs/api/v1/customer/accounts?phone=XXX
  getAccountsByPhone:          cbs.getAccountsByPhone,

  // Simulates: GET /cbs/api/v1/customer/accounts/details?phone=XXX
  getAccountsWithDetails:      cbs.getAccountsWithDetails,

  // Simulates: GET /cbs/api/v1/customer/cards?phone=XXX
  getCardsByPhone:             cbs.getCardsByPhone,

  // Simulates: GET /cbs/api/v1/customer/loans?phone=XXX
  getLoansByPhone:             cbs.getLoansByPhone,

  // Simulates: GET /cbs/api/v1/customer/check-email?email=XXX
  checkEmailExists:            cbs.checkEmailExists,

  // ── OTP ───────────────────────────────────────────────────────────────────
  // Simulates: POST /cbs/api/v1/otp/request
  requestOtp:                  cbs.requestOtp,

  // Simulates: POST /cbs/api/v1/otp/verify
  verifyOtp:                   cbs.verifyOtp,

  // ── Record Updates ────────────────────────────────────────────────────────
  // Simulates: POST /cbs/api/v1/customer/phone/update
  updatePhone:                 cbs.updatePhone,

  // Simulates: POST /cbs/api/v1/customer/email/update
  updateEmail:                 cbs.updateEmail,

  // Simulates: POST /cbs/api/v1/customer/address/update
  updateAddress:               cbs.updateAddress,

  // ── Account Status ────────────────────────────────────────────────────────
  // Simulates: GET /cbs/api/v1/account/status?accountNumber=XXX
  getAccountStatus:            cbs.getAccountStatus,

  // Simulates: POST /cbs/api/v1/account/activate
  activateAccount:             cbs.activateAccount,

  // ── Debug / Dev only ─────────────────────────────────────────────────────
  getPendingRequest:           cbs.getPendingRequest,

  REQUEST_TYPES:               cbs.REQUEST_TYPES,
};
