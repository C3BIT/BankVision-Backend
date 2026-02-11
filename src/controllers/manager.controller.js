const { errorResponseHandler } = require("../middlewares/errorResponseHandler");
const {
  managerRegistrationSchema,
  loginSchema,
} = require("../validations/managerValidations");
const {
  findManagerByEmail,
  registerManager,
} = require("../services/managerService");
const { statusCodes } = require("../utils/statusCodes");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { verifyOTP } = require("../services/otpService");
const { jwtSecret } = require("../configs/variables");
const { validatePassword, getPasswordRequirements } = require("../utils/passwordPolicy");
const { createSession, getSession, hasOtherActiveSession, invalidateSession } = require("../utils/sessionManager");
const {
  checkAccountLocked,
  recordFailedAttempt,
  recordSuccessfulLogin,
  validatePasswordChange,
  addToPasswordHistory
} = require("../utils/accountSecurity");
const {
  logLoginSuccess,
  logLoginFailed,
  logAccountLocked,
  logLogout,
  logPasswordChange,
  getClientIP
} = require("../services/loggingService");
const { setAuthCookie, clearAuthCookie } = require("../utils/cookieHelper");
const { checkPasswordExpiry } = require("../middlewares/passwordExpiryMiddleware");


const registerManagerController = async (req, res) => {
  try {
    const { name, email, password, verificationOtp } = req.body;
    const { error } = managerRegistrationSchema.validate({
      name,
      email,
      password,
    });
    if (error) {
      throw Object.assign(new Error(error.details[0].message), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40001 },
      });
    }

    // Validate password against policy
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.isValid) {
      throw Object.assign(new Error(passwordValidation.errors.join('. ')), {
        status: statusCodes.BAD_REQUEST,
        error: {
          code: 40001,
          details: passwordValidation.errors,
          requirements: getPasswordRequirements()
        },
      });
    }

    const verification = await verifyOTP(email, verificationOtp);
    if (!verification) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40011 },
      });
    }
    const existingManager = await findManagerByEmail(email);
    if (existingManager) {
      throw Object.assign(new Error(), {
        status: statusCodes.CONFLICT,
        error: { code: 40005 },
      });
    }
    const hashPassword = await bcrypt.hash(password, 10);
    const manager = await registerManager({
      name,
      email,
      password: hashPassword,
    });
    const responseData = {
      name: manager.name,
      email: manager.email,
    };
    res.created(responseData, "Manager Created Successfully!");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};


const loginManagerController = async (req, res) => {
  try {
    const { email, password, forceLogin } = req.body;
    const { error } = loginSchema.validate({ email, password });

    if (error) {
      throw Object.assign(new Error(error.details[0].message), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40001 },
      });
    }

    const manager = await findManagerByEmail(email);

    if (!manager) {
      // Log failed login - user not found (internal logging only)
      logLoginFailed(req, email, 'User not found');
      // Generic error message - don't reveal if email exists
      throw Object.assign(new Error("Invalid email or password"), {
        status: statusCodes.UNAUTHORIZED,
        error: { code: 40101 },
      });
    }

    // Check if account is active
    if (manager.isActive === false) {
      // Log the real reason internally
      logLoginFailed(req, email, 'Account deactivated');
      // Generic error message - don't reveal account status
      throw Object.assign(new Error("Invalid email or password"), {
        status: statusCodes.UNAUTHORIZED,
        error: { code: 40101 },
      });
    }

    // Check if account is locked
    const lockStatus = checkAccountLocked(manager);
    if (lockStatus.isLocked) {
      logLoginFailed(req, email, 'Account locked', manager.failedLoginAttempts);
      throw Object.assign(new Error(lockStatus.message), {
        status: statusCodes.FORBIDDEN,
        error: {
          code: 40302,
          remainingMinutes: lockStatus.remainingMinutes,
          isLocked: true
        },
      });
    }

    // If lock just expired, reset the counter
    if (lockStatus.wasLocked) {
      manager.lockedUntil = null;
      manager.failedLoginAttempts = 0;
      await manager.save();
    }

    const isPasswordValid = await bcrypt.compare(password, manager.password);

    if (!isPasswordValid) {
      // Record failed attempt
      const failResult = await recordFailedAttempt(manager);

      // Log failed login
      logLoginFailed(req, email, 'Invalid password', manager.failedLoginAttempts);

      // If account just got locked, log it
      if (failResult.locked) {
        logAccountLocked(req, email, manager.failedLoginAttempts);
      }

      throw Object.assign(new Error(failResult.message), {
        status: statusCodes.UNAUTHORIZED,
        error: {
          code: 40102,
          attemptsRemaining: failResult.attemptsRemaining,
          isLocked: failResult.locked
        },
      });
    }

    // Record successful login (resets failed attempts)
    await recordSuccessfulLogin(manager);

    // Log successful login
    logLoginSuccess(req, manager, 'manager');

    // Check password expiry (90-day rotation policy)
    const expiryStatus = checkPasswordExpiry(manager.passwordChangedAt);

    if (expiryStatus.isExpired) {
      throw Object.assign(new Error("Your password has expired. Please reset your password to continue."), {
        status: statusCodes.FORBIDDEN,
        error: {
          code: 40303,
          passwordExpired: true,
          requiresPasswordChange: true
        }
      });
    }

    const payload = {
      id: manager.id,
      email: manager.email,
      role: "manager"
    };

    const token = jwt.sign(
      payload, jwtSecret,
      { expiresIn: "8h" }
    );

    // Auto-logout any existing session (single session enforcement)
    // Check BEFORE creating new session, but AFTER generating token
    const hasExistingSession = await hasOtherActiveSession(manager.id, token);
    if (hasExistingSession) {
      // Get old session's socket ID before invalidating
      const oldSession = await getSession(manager.id);
      const oldSocketId = oldSession?.socketId;

      // Invalidate previous session (MUST await to prevent race condition)
      await invalidateSession(manager.id);
      console.log(`🔐 Auto-logout: Previous session invalidated for ${email} (new login from different device)`);

      // Notify old session via socket to force logout
      const io = req.app.get('io');
      if (io && oldSocketId) {
        io.to(oldSocketId).emit('force-logout', {
          userId: manager.id,
          email: manager.email,
          reason: 'New login from another device'
        });
        console.log(`🔐 Force logout sent to socket: ${oldSocketId}`);
      }
    }

    // Create session record AFTER invalidating old session
    await createSession(manager.id, token, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip || req.connection?.remoteAddress
    });

    // Set token as httpOnly cookie (secure, cannot be accessed by JavaScript)
    setAuthCookie(res, token, 8 * 60 * 60 * 1000); // 8 hours

    const responseData = {
      manager: {
        id: manager.id,
        name: manager.name,
        email: manager.email,
        profileImage: manager.profileImage
      },
      // Token sent via httpOnly cookie AND response body for backward compatibility
      token: token
    };

    // Add password expiry warning if applicable
    if (expiryStatus.showWarning) {
      responseData.passwordExpiryWarning = {
        message: `Your password will expire in ${expiryStatus.daysRemaining} days. Please change it soon.`,
        daysRemaining: expiryStatus.daysRemaining
      };
    }

    res.success(responseData, "Login successful!");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const forgotPasswordController = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      throw Object.assign(new Error("Email is required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40001 },
      });
    }

    const manager = await findManagerByEmail(email);

    if (!manager) {
      // Don't reveal if email exists or not for security
      return res.success({}, "If an account exists with this email, you will receive a password reset OTP.");
    }

    const { sendOTP } = require("../services/otpService");
    await sendOTP(email);

    res.success({}, "Password reset OTP sent to your email.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const resetPasswordController = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      throw Object.assign(new Error("Email, OTP, and new password are required"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40001 },
      });
    }

    // Validate password against policy
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.isValid) {
      throw Object.assign(new Error(passwordValidation.errors.join('. ')), {
        status: statusCodes.BAD_REQUEST,
        error: {
          code: 40001,
          details: passwordValidation.errors,
          requirements: getPasswordRequirements()
        },
      });
    }

    const isValid = await verifyOTP(email, otp);

    if (!isValid) {
      throw Object.assign(new Error("Invalid or expired OTP"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40011 },
      });
    }

    const manager = await findManagerByEmail(email);

    if (!manager) {
      // Generic error - don't reveal account existence
      throw Object.assign(new Error("Password reset failed. Please try again or contact support."), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40001 },
      });
    }

    // Check password history - cannot reuse recent passwords
    const historyCheck = await validatePasswordChange(
      newPassword,
      manager.password,
      manager.passwordHistory || []
    );

    if (!historyCheck.valid) {
      throw Object.assign(new Error(historyCheck.message), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40012 },
      });
    }

    const hashPassword = await bcrypt.hash(newPassword, 10);

    // Add current password to history before updating
    manager.passwordHistory = addToPasswordHistory(manager.password, manager.passwordHistory || []);
    manager.password = hashPassword;
    manager.passwordChangedAt = new Date();

    // Unlock account on password reset
    manager.failedLoginAttempts = 0;
    manager.lockedUntil = null;
    manager.lastFailedLogin = null;

    await manager.save();

    // Invalidate any existing sessions after password change
    invalidateSession(manager.id);

    // Log password change
    logPasswordChange(req, email, 'password_reset_success');

    res.success({}, "Password reset successfully. You can now login with your new password.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

const logoutManagerController = async (req, res) => {
  try {
    const managerId = req.user?.id;

    if (managerId) {
      // Log logout
      logLogout(req, req.user, 'manager');
      invalidateSession(managerId);
    }

    res.success({}, "Logged out successfully");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

module.exports = {
  registerManagerController,
  loginManagerController,
  forgotPasswordController,
  resetPasswordController,
  logoutManagerController
};
