const errorCodes = {
  // ================== 400 - Bad Request Errors ==================
  40001: {
    reason: "ValidationInvalidField",
    message: "One or more fields contain invalid values.",
  },
  40002: {
    reason: "MissingRequiredField",
    message: "A required field is missing.",
  },
  40003: {
    reason: "InvalidRequestBody",
    message: "Request body format is invalid.",
  },
  40004: {
    reason: "ValidationError",
    message: "Invalid email format. Please provide a valid email.",
  },
  40005: {
    reason: "DuplicateEmail",
    message: "This email is already registered. Please use a different email.",
  },
  40006: {
    reason: "DuplicatePhone",
    message:
      "This phone number is already registered. Please use a different number.",
  },
  40007: {
    reason: "InvalidPhoneFormat",
    message: "Invalid phone number format. Please enter a valid phone number.",
  },
  40008: {
    reason: "InvalidPasswordFormat",
    message: "Password must meet security requirements.",
  },
  40009: {
    reason: "WeakPassword",
    message: "Password is too weak. Please use a stronger password.",
  },
  40010: {
    reason: "Email Address",
    message: "Email Address is required",
  },
  40011: {
    reason: "InvalidOtp",
    message: "OTP verification failed",
  },
  40012: {
    reason: "Phone Number",
    message: "Phone Number is Required ",
  },
  40013: {
    reason: "OTP code",
    message: "Verification OTP is Required ",
  },
  40030: {
    reason: "Image Missing",
    message: "Image Path is Required",
  },
  40031: {
    reason: "Customer Address",
    message: "Customer Address is required",
  },
  // ================== 401 - Unauthorized Errors ==================
  40101: {
    reason: "UnauthorizedAccess",
    message: "You are not authorized to access this resource.",
  },
  40102: {
    reason: "InvalidCredentials",
    message: "Invalid email or password. Please try again.",
  },
  40103: {
    reason: "AccountBlocked",
    message: "Your account has been blocked. Please contact customer support.",
  },
  40104: {
    reason: "AccountSuspended",
    message: "Your account is suspended. Contact support for assistance.",
  },
  40105: {
    reason: "PhoneVerificationRequired",
    message: "You must verify your phone number before proceeding.",
  },
  40106: {
    reason: "EmailVerificationRequired",
    message: "You must verify your email before proceeding.",
  },
  40107: {
    reason: "OldPasswordMismatch",
    message: "The old password provided is incorrect.",
  },

  // ================== 403 - Forbidden Errors ==================
  40301: {
    reason: "AccessDenied",
    message: "You do not have permission to perform this action.",
  },
  40302: {
    reason: "InsufficientPrivileges",
    message: "Admin privileges are required to access this resource.",
  },

  // ================== 404 - Not Found Errors ==================
  40401: {
    reason: "UserNotFound",
    message: "User not found. Please check the details and try again.",
  },
  40402: {
    reason: "ResourceNotFound",
    message: "The requested resource was not found.",
  },

  // ================== 409 - Conflict Errors ==================
  40901: {
    reason: "DuplicateEntry",
    message: "An account with this phone number already exists",
  },

  // ================== 500 - Internal Server Errors ==================
  50001: {
    reason: "InternalServerError",
    message: "An unexpected error occurred. Please try again later.",
  },
  50002: {
    reason: "DatabaseError",
    message: "A database error occurred. Please try again later.",
  },
  50003: {
    reason: "ServiceUnavailable",
    message: "The service is temporarily unavailable. Please try again later.",
  },

  // ================== Token & Authentication Errors ==================
  40110: {
    reason: "TokenExpired",
    message: "Authentication failed. Your session has expired.",
  },
  40111: {
    reason: "InvalidToken",
    message: "Invalid authentication token provided.",
  },
  40112: {
    reason: "TokenVerificationFailed",
    message: "Token verification failed. Please log in again.",
  },
  40113: {
    reason: "NoTokenProvided",
    message: "Authentication failed. No token provided.",
  },
  40114: {
    reason: "UnauthorizedRoleAccess",
    message: "You do not have permission to access this resource.",
  },
};

module.exports = { errorCodes };
