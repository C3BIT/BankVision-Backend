const { errorResponseHandler } = require("../middlewares/errorResponseHandler");
const {
  createCustomer,
  getAccountsListByPhone,
  updatePhoneByAccountNumber,
  updateEmailByAccountNumber,
  updateAddressByAccountNumber,
  getCustomerInfoByAccountNumber,
  getCustomerImageByPhone,
  checkVerificationStatus,
} = require("../services/customerService");
const { generateRandomNumberBySize } = require("../utils/generateRandomNumber");
const { statusCodes } = require("../utils/statusCodes");
const { createCustomerSchema } = require("../validations/customerValidations");

const createCustomerController = async (req, res) => {
  try {
    const { mobileNumber, email, name, address, branch, profileImage } =
      req.body;
    const { error } = createCustomerSchema.validate({
      mobileNumber,
      email,
      name,
      address,
      branch,
      profileImage,
    });
    if (error) {
      throw Object.assign(new Error(error.details[0].message), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40001 },
      });
    }
    const accountNumber = generateRandomNumberBySize(10);
    const customer = await createCustomer({
      accountNumber,
      mobileNumber,
      email,
      name,
      address,
      branch,
      profileImage,
    });
    res.created(customer, "Customer Created Successfully.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const getAccountsListByPhoneController = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }
    const accounsList = await getAccountsListByPhone(phone);
    res.success(accounsList, "Account List by Phone Fetched Successfully");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const checkDuplicateEmailController = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40010 },
      });
    }
    const { checkEmailExists } = require("../services/customerService");
    const existingAccounts = await checkEmailExists(email);
    res.success({ data: existingAccounts }, "Account List by Email Fetched Successfully");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const handleUpdatePhoneByAccountNumber = async (req, res) => {
  try {
    const { accountNumber, phone } = req.body;
    if (!accountNumber) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40002 },
      });
    }
    if (!phone) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }
    const isPhoneUpadated = await updatePhoneByAccountNumber({
      accountNumber,
      newPhone: phone,
    });
    res.success({ isPhoneUpadated }, "Phone Upadated Request Successfull.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};
const handleUpdateEmailByAccountNumber = async (req, res) => {
  try {
    const { accountNumber, email } = req.body;
    if (!accountNumber) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40002 },
      });
    }
    if (!email) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40010 },
      });
    }
    const isEmailUpadated = await updateEmailByAccountNumber({
      accountNumber,
      newEmail: email,
    });
    res.success({ isEmailUpadated }, "Email Upadated Request Successfull.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};
const handleUpdateAddressByAccountNumber = async (req, res) => {
  try {
    const { accountNumber, address } = req.body;
    if (!accountNumber) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40002 },
      });
    }
    if (!address) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40031 },
      });
    }
    const isAddressUpadated = await updateAddressByAccountNumber({
      accountNumber,
      newAddress: address,
    });
    res.success({ isAddressUpadated }, "Address Upadated Request Successfull.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};
const handleGetCustomerInfoByAccountNb = async (req, res) => {
  try {
    const { accountNumber, phone } = req.body;
    if (!accountNumber) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40002 },
      });
    }
    const customer = await getCustomerInfoByAccountNumber(accountNumber, phone);
    if (!customer) {
      throw Object.assign(new Error(), {
        status: statusCodes.NOT_FOUND,
        error: { code: 40401 },
      });
    }
    res.success(customer, "Customer Deatils Fetch Successfully.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const getCustomerImageByPhoneController = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }
    const profileImage = await getCustomerImageByPhone(phone);
    res.success(profileImage, " profileImage by Phone Fetched Successfully");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const checkVerificationStatusController = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }
    const verificationStatus = await checkVerificationStatus(phone);
    res.success(verificationStatus, "Verification status fetched successfully");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

module.exports = {
  createCustomerController,
  getAccountsListByPhoneController,
  handleUpdatePhoneByAccountNumber,
  handleUpdateEmailByAccountNumber,
  handleUpdateAddressByAccountNumber,
  handleGetCustomerInfoByAccountNb,
  getCustomerImageByPhoneController,
  checkVerificationStatusController,
  checkDuplicateEmailController
};
