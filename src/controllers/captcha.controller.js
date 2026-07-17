const { errorResponseHandler } = require("../middlewares/errorResponseHandler");
const { generateCaptcha } = require("../services/captchaService");

const generateCaptchaController = async (req, res) => {
  try {
    const { captchaId, svg } = await generateCaptcha();
    res.success({ captchaId, svg }, "Captcha generated");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

module.exports = { generateCaptchaController };
