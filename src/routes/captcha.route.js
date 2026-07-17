const { Router } = require("express");
const { generateCaptchaController } = require("../controllers/captcha.controller");

const router = new Router();

router.get("/generate", generateCaptchaController);

module.exports = router;
