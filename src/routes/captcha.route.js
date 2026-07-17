const { Router } = require("express");
const { generateCaptchaController } = require("../controllers/captcha.controller");

const router = new Router();

/**
 * @swagger
 * tags:
 *   name: Captcha
 *   description: CAPTCHA challenge generation for public-facing forms
 */

/**
 * @swagger
 * /captcha/generate:
 *   get:
 *     summary: Generate a new CAPTCHA challenge
 *     tags: [Captcha]
 *     security: []
 *     responses:
 *       200: { description: CAPTCHA challenge (id + image) }
 */
router.get("/generate", generateCaptchaController);

module.exports = router;
