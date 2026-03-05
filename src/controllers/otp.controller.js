const { errorResponseHandler } = require("../middlewares/errorResponseHandler");
const OTP = require("../services/otpService");
const { statusCodes } = require("../utils/statusCodes");
const sendOtpController = async (req, res) => {
  try {
    const { email, checkDuplicate } = req.body;

    if (!email) {
      throw Object.assign(new Error("Email Address is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40010 },
      });
    }

    // When used for email change, check if email is already registered
    if (checkDuplicate) {
      const { checkEmailExists } = require("../services/customerService");
      const existingAccounts = await checkEmailExists(email);
      if (existingAccounts && existingAccounts.length > 0) {
        throw Object.assign(
          new Error("This email is already registered to another account"),
          {
            status: statusCodes.BAD_REQUEST,
            error: { code: 40015 },
          }
        );
      }
    }

    try {
      await OTP.sendOTP(email);
      return res.success({ email }, "OTP sent successfully.");
    } catch (otpError) {
      // If error already has status, preserve it; otherwise set to 400
      if (!otpError.status) {
        otpError.status = statusCodes.BAD_REQUEST;
        otpError.error = { code: 40014 };
      }
      throw otpError;
    }
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const sendPhoneOtpController = async (req, res) => {
  try {
    const { phone, checkDuplicate } = req.body;
    if (!phone) {
      throw Object.assign(new Error("Phone number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }

    // When used for phone change, check if number is already registered
    if (checkDuplicate) {
      const { getAccountsListByPhone } = require("../services/customerService");
      const existingAccounts = await getAccountsListByPhone(phone);
      if (existingAccounts && existingAccounts.length > 0) {
        throw Object.assign(
          new Error("This phone number is already registered to another account"),
          {
            status: statusCodes.BAD_REQUEST,
            error: { code: 40015 },
          }
        );
      }
    }

    await OTP.sendtPhoneOtp(phone);
    return res.success({ phone }, "OTP sent successfully.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const verifyPhoneOtpController = async (req, res) => {
  try {
    const { phone, otp } = req.body;
    if (!phone) {
      throw Object.assign(new Error("Phone number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }
    if (!otp) {
      throw Object.assign(new Error("OTP is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40013 },
      });
    }
    const isVerified = await OTP.verifyPhoneOtp(phone, otp);
    if (!isVerified) {
      throw Object.assign(new Error("Invalid or expired OTP"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40011 },
      });
    }
    res.success({ isVerified }, "Verificaion Successfull.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const verifyEmailController = async (req, res) => {
  try {
    const { email, otp, phone } = req.body;

    // Support both email and phone-based email verification
    let emailToVerify = email;
    if (!emailToVerify && phone) {
      // If phone provided, get email from customer service
      const { getAccountsListByPhone } = require("../services/customerService");
      const accounts = await getAccountsListByPhone(phone);
      if (accounts.length > 0 && accounts[0].email) {
        emailToVerify = accounts[0].email;
      }
    }

    if (!emailToVerify) {
      throw Object.assign(new Error("Email is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40010 },
      });
    }

    if (!otp) {
      throw Object.assign(new Error("OTP is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40013 },
      });
    }

    const isVerified = await OTP.verifyOTP(emailToVerify, otp);

    if (!isVerified) {
      throw Object.assign(new Error("Invalid or expired OTP"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40011 },
      });
    }

    return res.success(
      { isEmailVerified: isVerified },
      "Email verified successfully"
    );
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const sendExternalPhoneOtpController = async (req, res) => {
  try {
    const { phone, externalPhone } = req.body;

    if (!phone) {
      throw Object.assign(new Error("Customer phone number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }

    if (!externalPhone) {
      throw Object.assign(new Error("External phone number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }

    await OTP.sendExternalPhoneOtp(phone, externalPhone);
    return res.success(
      { phone, externalPhone },
      "OTP sent to external phone successfully. This number is not visible to the agent."
    );
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const verifyExternalPhoneOtpController = async (req, res) => {
  try {
    const { phone, externalPhone, otp } = req.body;

    if (!phone) {
      throw Object.assign(new Error("Customer phone number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }

    if (!externalPhone) {
      throw Object.assign(new Error("External phone number is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }

    if (!otp) {
      throw Object.assign(new Error("OTP is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40013 },
      });
    }

    const isVerified = await OTP.verifyExternalPhoneOtp(phone, externalPhone, otp);

    if (!isVerified) {
      throw Object.assign(new Error("Invalid or expired OTP"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40011 },
      });
    }

    return res.success(
      { isVerified },
      "External phone OTP verified successfully"
    );
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

module.exports = {
  sendOtpController,
  sendPhoneOtpController,
  verifyPhoneOtpController,
  verifyEmailController,
  sendExternalPhoneOtpController,
  verifyExternalPhoneOtpController,
};
