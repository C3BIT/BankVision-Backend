const express = require('express');
const router = express.Router();
const jsonwebtoken = require('jsonwebtoken');
const { downloadForm } = require('../controllers/forms.controller');
const { jwtSecret } = require('../configs/variables');
const { getTokenFromRequest } = require('../utils/cookieHelper');

// Accept any valid JWT with role manager, admin, or supervisor
const anyStaffAuth = (req, res, next) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  try {
    const decoded = jsonwebtoken.verify(token, jwtSecret, { algorithms: ['HS256'] });
    const allowed = ['manager', 'admin', 'supervisor'];
    if (!allowed.includes(decoded.role)) {
      return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    }
    req.user = decoded;
    return next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

/**
 * @swagger
 * tags:
 *   name: Forms
 *   description: Downloadable form templates (manager/admin/supervisor only)
 */

/**
 * @swagger
 * /forms/download:
 *   get:
 *     summary: Download a form template
 *     tags: [Forms]
 *     responses:
 *       200: { description: Form file }
 *       401: { description: Authentication required }
 *       403: { description: Insufficient permissions }
 */
router.get('/download', anyStaffAuth, downloadForm);

module.exports = router;
