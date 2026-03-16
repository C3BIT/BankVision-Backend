const express = require("express");
const router = express.Router();
const cbsController = require("../controllers/cbs.controller");
const { managerAuthenticateMiddleware } = require("../middlewares/authMiddleware");

// Customer Lookup
router.post("/customer/lookup", managerAuthenticateMiddleware, cbsController.lookupCustomer);

// Customer Data
router.post("/customer/accounts", managerAuthenticateMiddleware, cbsController.getAccounts);
router.post("/customer/cards", managerAuthenticateMiddleware, cbsController.getCards);
router.post("/customer/loans", managerAuthenticateMiddleware, cbsController.getLoans);

// OTP Management
router.post("/otp/request", managerAuthenticateMiddleware, cbsController.requestOtp);
router.post("/otp/verify", managerAuthenticateMiddleware, cbsController.verifyOtp);

// Service Updates
router.post("/phone/update", managerAuthenticateMiddleware, cbsController.updatePhone);
router.post("/email/update", managerAuthenticateMiddleware, cbsController.updateEmail);
router.post("/address/update", managerAuthenticateMiddleware, cbsController.updateAddress);

// Account Management
router.post("/account/status", managerAuthenticateMiddleware, cbsController.getAccountStatus);
router.post("/account/activate", managerAuthenticateMiddleware, cbsController.activateAccount);

// Development only - get pending request details (requires auth to prevent OTP exposure)
router.get("/request/:requestId", managerAuthenticateMiddleware, cbsController.getPendingRequest);

module.exports = router;
