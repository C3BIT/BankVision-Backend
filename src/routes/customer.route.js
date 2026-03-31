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

const router = Router();
router.post("/create", createCustomerController);
router.post("/find-phone", getAccountsListByPhoneController);
router.post("/find-email", checkDuplicateEmailController);
router.post("/update-phone", handleUpdatePhoneByAccountNumber);
router.post("/update-email", handleUpdateEmailByAccountNumber);
router.post("/update-address", handleUpdateAddressByAccountNumber);
router.post("/details", handleGetCustomerInfoByAccountNb);
router.post("/profile-image", getCustomerImageByPhoneController);
router.post("/check-verification-status", checkVerificationStatusController);
module.exports = router;
