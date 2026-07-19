const { Router } = require("express");
const {
  createCustomerController,
  getAccountsListByPhoneController,
  handleUpdatePhoneByAccountNumber,
  handleUpdateEmailByAccountNumber,
  handleUpdateAddressByAccountNumber,
  handleGetCustomerInfoByAccountNb,
  getCustomerImageByPhoneController,
  checkVerificationStatusController,
  checkDuplicateEmailController,
} = require("../controllers/customer.controller");
const { customerAuthenticateMiddleware } = require("../middlewares/authMiddleware");

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Customer
 *   description: Customer record creation, lookup, and profile updates
 */

/**
 * @swagger
 * /customer/create:
 *   post:
 *     summary: Create a customer record
 *     tags: [Customer]
 *     responses:
 *       201: { description: Customer created }
 */
router.post("/create", createCustomerController);
/**
 * @swagger
 * /customer/find-phone:
 *   post:
 *     summary: Find accounts associated with a phone number
 *     tags: [Customer]
 *     responses:
 *       200: { description: Accounts found }
 */
router.post("/find-phone", customerAuthenticateMiddleware, getAccountsListByPhoneController);
/**
 * @swagger
 * /customer/find-email:
 *   post:
 *     summary: Check whether an email is already in use
 *     tags: [Customer]
 *     responses:
 *       200: { description: Duplicate-check result }
 */
router.post("/find-email", customerAuthenticateMiddleware, checkDuplicateEmailController);
/**
 * @swagger
 * /customer/update-phone:
 *   post:
 *     summary: Update a customer's phone number by account number
 *     tags: [Customer]
 *     responses:
 *       200: { description: Phone updated }
 */
router.post("/update-phone", customerAuthenticateMiddleware, handleUpdatePhoneByAccountNumber);
/**
 * @swagger
 * /customer/update-email:
 *   post:
 *     summary: Update a customer's email by account number
 *     tags: [Customer]
 *     responses:
 *       200: { description: Email updated }
 */
router.post("/update-email", customerAuthenticateMiddleware, handleUpdateEmailByAccountNumber);
/**
 * @swagger
 * /customer/update-address:
 *   post:
 *     summary: Update a customer's address by account number
 *     tags: [Customer]
 *     responses:
 *       200: { description: Address updated }
 */
router.post("/update-address", customerAuthenticateMiddleware, handleUpdateAddressByAccountNumber);
/**
 * @swagger
 * /customer/details:
 *   post:
 *     summary: Get customer info by account number
 *     tags: [Customer]
 *     responses:
 *       200: { description: Customer details }
 */
router.post("/details", customerAuthenticateMiddleware, handleGetCustomerInfoByAccountNb);
/**
 * @swagger
 * /customer/profile-image:
 *   post:
 *     summary: Get a customer's stored profile image by phone number
 *     tags: [Customer]
 *     responses:
 *       200: { description: Profile image reference }
 */
router.post("/profile-image", customerAuthenticateMiddleware, getCustomerImageByPhoneController);
/**
 * @swagger
 * /customer/check-verification-status:
 *   post:
 *     summary: Check a customer's KYC verification status
 *     tags: [Customer]
 *     responses:
 *       200: { description: Verification status }
 */
router.post("/check-verification-status", customerAuthenticateMiddleware, checkVerificationStatusController);
module.exports = router;
