const express = require("express");
const router = express.Router();
const cbsController = require("../controllers/cbs.controller");
const { managerAuthenticateMiddleware } = require("../middlewares/authMiddleware");

/**
 * @swagger
 * tags:
 *   name: CBS
 *   description: Core Banking System integration — customer lookup, accounts/cards/loans, service updates
 */

/**
 * @swagger
 * /cbs/customer/lookup:
 *   post:
 *     summary: Look up a customer in the core banking system
 *     tags: [CBS]
 *     responses:
 *       200: { description: Customer record }
 */
router.post("/customer/lookup", managerAuthenticateMiddleware, cbsController.lookupCustomer);

/**
 * @swagger
 * /cbs/customer/accounts:
 *   post:
 *     summary: Get a customer's accounts
 *     tags: [CBS]
 *     responses:
 *       200: { description: Accounts list }
 */
router.post("/customer/accounts", managerAuthenticateMiddleware, cbsController.getAccounts);
/**
 * @swagger
 * /cbs/customer/cards:
 *   post:
 *     summary: Get a customer's cards
 *     tags: [CBS]
 *     responses:
 *       200: { description: Cards list }
 */
router.post("/customer/cards", managerAuthenticateMiddleware, cbsController.getCards);
/**
 * @swagger
 * /cbs/customer/loans:
 *   post:
 *     summary: Get a customer's loans
 *     tags: [CBS]
 *     responses:
 *       200: { description: Loans list }
 */
router.post("/customer/loans", managerAuthenticateMiddleware, cbsController.getLoans);

/**
 * @swagger
 * /cbs/otp/request:
 *   post:
 *     summary: Request a CBS-side OTP for a sensitive account update
 *     tags: [CBS]
 *     responses:
 *       200: { description: OTP requested }
 */
router.post("/otp/request", managerAuthenticateMiddleware, cbsController.requestOtp);
/**
 * @swagger
 * /cbs/otp/verify:
 *   post:
 *     summary: Verify a CBS-side OTP
 *     tags: [CBS]
 *     responses:
 *       200: { description: OTP verified }
 */
router.post("/otp/verify", managerAuthenticateMiddleware, cbsController.verifyOtp);

/**
 * @swagger
 * /cbs/phone/update:
 *   post:
 *     summary: Update a customer's phone number in CBS
 *     tags: [CBS]
 *     responses:
 *       200: { description: Phone updated }
 */
router.post("/phone/update", managerAuthenticateMiddleware, cbsController.updatePhone);
/**
 * @swagger
 * /cbs/email/update:
 *   post:
 *     summary: Update a customer's email in CBS
 *     tags: [CBS]
 *     responses:
 *       200: { description: Email updated }
 */
router.post("/email/update", managerAuthenticateMiddleware, cbsController.updateEmail);
/**
 * @swagger
 * /cbs/address/update:
 *   post:
 *     summary: Update a customer's address in CBS
 *     tags: [CBS]
 *     responses:
 *       200: { description: Address updated }
 */
router.post("/address/update", managerAuthenticateMiddleware, cbsController.updateAddress);

/**
 * @swagger
 * /cbs/account/status:
 *   post:
 *     summary: Get an account's status (e.g. dormant/active)
 *     tags: [CBS]
 *     responses:
 *       200: { description: Account status }
 */
router.post("/account/status", managerAuthenticateMiddleware, cbsController.getAccountStatus);
/**
 * @swagger
 * /cbs/account/activate:
 *   post:
 *     summary: Activate a dormant account
 *     tags: [CBS]
 *     responses:
 *       200: { description: Account activated }
 */
router.post("/account/activate", managerAuthenticateMiddleware, cbsController.activateAccount);

/**
 * @swagger
 * /cbs/request/{requestId}:
 *   get:
 *     summary: Get pending CBS request details (dev/debug, auth-protected to prevent OTP exposure)
 *     tags: [CBS]
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Pending request details }
 */
router.get("/request/:requestId", managerAuthenticateMiddleware, cbsController.getPendingRequest);

module.exports = router;
