const { Router } = require('express');
const { getHealth } = require('../controllers/health.controller');


const router = Router();

/**
 * @swagger
 * tags:
 *   name: Health
 *   description: Service health check
 */

/**
 * @swagger
 * /dev/health:
 *   get:
 *     summary: Check API health
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200: { description: Service is healthy }
 */
router.get('/health', getHealth);

module.exports = router;