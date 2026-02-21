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
  getSecuritySummary,
  downloadRecording,
  toggleWhisperMode,
  getWhisperMode,
  syncRecordings
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
router.get('/recordings/:id/download', adminAuthenticateMiddleware, downloadRecording);
router.get('/recordings/:id', adminAuthenticateMiddleware, getRecording);
router.put('/recordings/:id', adminAuthenticateMiddleware, updateRecording);
router.delete('/recordings/:id', adminAuthenticateMiddleware, deleteRecording);
router.post('/recordings/sync', adminAuthenticateMiddleware, syncRecordings);

// Supervisor routes
router.get('/active-calls', supervisorAuthMiddleware, getActiveCalls);

// Supervisor whisper / silent monitoring
router.post('/supervisor/whisper-token', supervisorAuthMiddleware, generateWhisperToken);
router.put('/supervisor/whisper-mode', supervisorAuthMiddleware, toggleWhisperMode);
router.get('/supervisor/whisper-mode', supervisorAuthMiddleware, getWhisperMode);

// Security & Audit Logs (super_admin only)
router.get('/logs/authentication', adminAuthenticateMiddleware, getAuthenticationLogs);
router.get('/logs/transactions', adminAuthenticateMiddleware, getTransactionLogs);
router.get('/logs/admin-activity', adminAuthenticateMiddleware, getAdminActivityLogs);
router.get('/security/summary', adminAuthenticateMiddleware, getSecuritySummary);

module.exports = router;
