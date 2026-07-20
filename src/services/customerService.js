/**
 * Customer Service
 *
 * This service fetches customer data from CBS (Core Banking System).
 * All CBS calls go through cbsService.js — swap that file when real APIs arrive.
 */

const cbsService = require("./cbsService");

/**
 * Get list of accounts by phone number
 * @param {string} phone - Customer's phone number
 * @returns {Array} - List of accounts with accountNumber and branch
 */
const getAccountsListByPhone = async (phone) => {
  console.log(`📞 Fetching accounts from CBS for phone: ${phone}`);

  const accounts = await cbsService.getAccountsByPhone(phone).catch(() => []);

  if (accounts.length === 0) {
    console.log(`❌ No accounts found in CBS for phone: ${phone}`);
    return accounts;
  }

  console.log(`✅ Found ${accounts.length} account(s) in CBS for phone: ${phone}`);

  // Enrich accounts with profile and signature images from CBS
  const lookup = await cbsService.lookupCustomerByPhone(phone).catch(() => ({}));
  const { profileImage = null, signatureImage = null } = lookup;

  return accounts.map(acc => ({ ...acc, profileImage, signatureImage }));
};

/**
 * Get customer info by account number, including cards and loans
 * @param {string} accountNumber - Customer's account number
 * @param {string} phone - Customer's phone number (used for cards/loans lookup)
 * @returns {Object|null} - Customer info with cards and loans, or null if not found
 */
const getCustomerInfoByAccountNumber = async (accountNumber, phone = null) => {
  console.log(`🔍 Fetching customer info from CBS for account: ${accountNumber}`);

  const customer = await cbsService.getCustomerByAccountNumber(accountNumber);

  if (!customer) {
    console.log(`❌ Customer not found in CBS for account: ${accountNumber}`);
    return null;
  }

  console.log(`✅ Found customer in CBS: ${customer.name}`);

  // Resolve phone for cards/loans lookup — prefer passed param, fallback to CBS mobile
  const lookupPhone = phone || (customer.mobileNumber && !customer.mobileNumber.startsWith('0')
    ? `0${customer.mobileNumber}`
    : customer.mobileNumber);

  const [cards, loans, photo, signature] = await Promise.all([
    lookupPhone ? cbsService.getCardsByPhone(lookupPhone).catch(() => []) : Promise.resolve([]),
    lookupPhone ? cbsService.getLoansByPhone(lookupPhone).catch(() => []) : Promise.resolve([]),
    // getCustomerPhoto looks up CBS's Photos array by CIF (CustomerNo), not
    // account number — passing the account number here always returns null.
    cbsService.getCustomerPhoto(customer.customerCIF).catch(() => null),
    cbsService.getCustomerSignature(customer.accountNumber).catch(() => null),
  ]);

  console.log(`💳 Cards: ${cards.length} | 🏦 Loans: ${loans.length}`);
  return { ...customer, cards, loans, profileImage: photo, signatureImage: signature };
};

/**
 * Get customer's profile image by phone
 * @param {string} phone - Customer's phone number
 * @returns {Object} - Object with profileImage URL
 */
const getCustomerImageByPhone = async (phone) => {
  console.log(`📸 Fetching profile image from CBS for phone: ${phone}`);

  const result = await cbsService.lookupCustomerByPhone(phone);

  if (!result.found || !result.profileImage) {
    console.log(`❌ No profile image found in CBS for phone: ${phone}`);
    return { profileImage: null };
  }

  console.log(`✅ Found profile image in CBS for: ${result.name}`);
  return { profileImage: result.profileImage };
};

/**
 * Update phone number (via CBS)
 * These are pass-through functions - actual updates happen in CBS
 */
const updatePhoneByAccountNumber = async ({ accountNumber, newPhone }) => {
  // In production, this would call CBS API to update phone
  // The actual update is done via CBS OTP verification flow
  console.log(`📱 Phone update request for account ${accountNumber} -> ${newPhone}`);
  console.log(`⚠️  Phone updates should go through CBS OTP verification flow`);
  return true;
};

/**
 * Update email (via CBS)
 */
const updateEmailByAccountNumber = async ({ accountNumber, newEmail }) => {
  // In production, this would call CBS API to update email
  // The actual update is done via CBS OTP verification flow
  console.log(`📧 Email update request for account ${accountNumber} -> ${newEmail}`);
  console.log(`⚠️  Email updates should go through CBS OTP verification flow`);
  return true;
};

/**
 * Update address (via CBS)
 */
const updateAddressByAccountNumber = async ({ accountNumber, newAddress }) => {
  // In production, this would call CBS API to update address
  // The actual update is done via CBS OTP verification flow
  console.log(`🏠 Address update request for account ${accountNumber}`);
  console.log(`⚠️  Address updates should go through CBS OTP verification flow`);
  return true;
};

/**
 * Create customer - NOT USED
 * Customers exist in CBS, we don't create them
 */
const createCustomer = async (data) => {
  console.log(`⚠️  createCustomer called - customers should exist in CBS, not created by us`);
  throw new Error("Customers are managed by CBS, not by this system");
};

/**
 * Check customer verification status (phone/email verified)
 * @param {string} phone - Customer's phone number
 * @returns {Object} - Verification status with hasVerifiedPhone, hasVerifiedEmail, verifiedPhone, verifiedEmail
 */
const checkVerificationStatus = async (phone) => {
  console.log(`🔍 Checking verification status for phone: ${phone}`);

  const customer = await cbsService.lookupCustomerByPhone(phone);

  if (!customer.found) {
    console.log(`❌ Customer not found for phone: ${phone}`);
    return {
      hasVerifiedPhone: false,
      hasVerifiedEmail: false,
      verifiedPhone: null,
      verifiedEmail: null,
    };
  }

  // Check if phone is verified (in production, this would check CBS verification status)
  // For now, we'll check if phone exists in CBS as verified
  // In production, CBS would have a verifiedPhone field
  const hasVerifiedPhone = customer.mobileNumber === phone; // Simplified: if phone matches, consider verified
  const verifiedPhone = hasVerifiedPhone ? customer.mobileNumber : null;

  // Check if email is verified (in production, this would check CBS verification status)
  // For foreign users, email must be pre-verified and registered
  const hasVerifiedEmail = !!customer.email && customer.email.includes('@'); // Simplified: if email exists, consider verified
  const verifiedEmail = hasVerifiedEmail ? customer.email : null;

  console.log(`✅ Verification status for ${phone}: phone=${hasVerifiedPhone}, email=${hasVerifiedEmail}`);

  return {
    hasVerifiedPhone,
    hasVerifiedEmail,
    verifiedPhone,
    verifiedEmail,
  };
};

/**
 * Check if email exists
 * @param {string} email - Customer's email
 * @returns {Array} - Accounts with that email
 */
const checkEmailExists = async (email) => {
  console.log(`🔍 Checking if email exists: ${email}`);

  const accounts = await cbsService.checkEmailExists(email) ?? [];

  return accounts;
};

module.exports = {
  createCustomer,
  getAccountsListByPhone,
  updatePhoneByAccountNumber,
  updateEmailByAccountNumber,
  updateAddressByAccountNumber,
  getCustomerInfoByAccountNumber,
  getCustomerImageByPhone,
  checkVerificationStatus,
  checkEmailExists
};
