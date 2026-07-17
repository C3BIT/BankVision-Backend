const { verifyCaptcha } = require("../services/captchaService");
const { statusCodes } = require("../utils/statusCodes");

// Guards a route with the self-hosted CAPTCHA: expects `captchaId` and
// `captchaAnswer` in the request body alongside the route's normal payload.
const requireCaptcha = async (req, res, next) => {
  const { captchaId, captchaAnswer } = req.body || {};

  try {
    if (!(await verifyCaptcha(captchaId, captchaAnswer))) {
      return res.status(statusCodes.BAD_REQUEST).json({
        status: "fail",
        message: "Invalid or expired captcha. Please try again.",
        data: null,
        error: { code: 40018 },
      });
    }
    next();
  } catch (error) {
    console.error("❌ Captcha verification error:", error.message);
    return res.status(statusCodes.BAD_REQUEST).json({
      status: "fail",
      message: "Invalid or expired captcha. Please try again.",
      data: null,
      error: { code: 40018 },
    });
  }
};

module.exports = { requireCaptcha };
