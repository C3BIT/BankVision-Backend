const { Router } = require('express');
const {
  registerAdmin,
  loginAdmin,
  getManagers,
  getDashboardStats,
  resetManagerPassword,
  getActiveCalls,
  getCallLogs,
  getRecordings,
  getRecording,
  updateRecording,
  deleteRecording,
  getAuthenticationLogs,
  getTransactionLogs,
  getAdminActivityLogs,
  getSecuritySummary
} = require('../controllers/admin.controller');
const { adminAuthenticateMiddleware, supervisorAuthMiddleware } = require('../middlewares/adminAuthMiddleware');
const { authRateLimiter } = require('../middlewares/securityMiddleware');

const router = new Router();

// Public routes (with rate limiting)
router.post('/login', authRateLimiter, loginAdmin);

// Protected routes (admin)
router.post('/register', adminAuthenticateMiddleware, registerAdmin);
router.get('/managers', adminAuthenticateMiddleware, getManagers);
router.get('/dashboard', adminAuthenticateMiddleware, getDashboardStats);
router.put('/managers/:managerId/reset-password', adminAuthenticateMiddleware, resetManagerPassword);
router.get('/call-logs', adminAuthenticateMiddleware, getCallLogs);

// Recording routes
router.get('/recordings', adminAuthenticateMiddleware, getRecordings);
router.get('/recordings/:id', adminAuthenticateMiddleware, getRecording);
router.put('/recordings/:id', adminAuthenticateMiddleware, updateRecording);
router.delete('/recordings/:id', adminAuthenticateMiddleware, deleteRecording);

// Supervisor routes
router.get('/active-calls', supervisorAuthMiddleware, getActiveCalls);

// Security & Audit Logs (super_admin only)
router.get('/logs/authentication', adminAuthenticateMiddleware, getAuthenticationLogs);
router.get('/logs/transactions', adminAuthenticateMiddleware, getTransactionLogs);
router.get('/logs/admin-activity', adminAuthenticateMiddleware, getAdminActivityLogs);
router.get('/security/summary', adminAuthenticateMiddleware, getSecuritySummary);

module.exports = router;
