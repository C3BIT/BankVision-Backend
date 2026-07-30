const { Router } = require('express');
const {
  registerAdmin,
  loginAdmin,
  logoutAdmin,
  resetPasswordAdmin,
  getCurrentAdmin,
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
  streamRecording,
  generateWhisperToken,
  toggleWhisperMode,
  getWhisperMode,
  syncRecordings,
  updateManagerStatus,
  deleteManager,
  getAgentMonitorData,
  getChangeRequests,
  getSystemSettings,
  updateSystemSetting,
  getManagerActivityReport
} = require('../controllers/admin.controller');
const { adminAuthenticateMiddleware, supervisorAuthMiddleware, superAdminAuthMiddleware } = require('../middlewares/adminAuthMiddleware');
const { authRateLimiter, passwordResetRateLimiter } = require('../middlewares/securityMiddleware');

const router = new Router();

/**
 * @swagger
 * tags:
 *   name: Admin
 *   description: Admin/supervisor dashboard, manager management, recordings, and audit logs
 */

/**
 * @swagger
 * /admin/login:
 *   post:
 *     summary: Admin login
 *     tags: [Admin]
 *     security: []
 *     responses:
 *       200: { description: Logged in }
 */
router.post('/login', authRateLimiter, loginAdmin);

/**
 * @swagger
 * /admin/reset-password:
 *   post:
 *     summary: Reset an admin's password directly by email (no OTP)
 *     tags: [Admin]
 *     security: []
 *     responses:
 *       200: { description: Password reset }
 *       400: { description: Invalid request }
 */
router.post('/reset-password', passwordResetRateLimiter, resetPasswordAdmin);

// Protected routes (admin)
/**
 * @swagger
 * /admin/logout:
 *   post:
 *     summary: Log out the current admin session
 *     tags: [Admin]
 *     responses:
 *       200: { description: Logged out }
 */
router.post('/logout', adminAuthenticateMiddleware, logoutAdmin);
/**
 * @swagger
 * /admin/me:
 *   get:
 *     summary: Get the currently authenticated admin (resolved from auth cookie/token)
 *     tags: [Admin]
 *     responses:
 *       200: { description: Current admin profile }
 *       401: { description: Not authenticated }
 */
router.get('/me', adminAuthenticateMiddleware, getCurrentAdmin);
/**
 * @swagger
 * /admin/register:
 *   post:
 *     summary: Register a new admin account
 *     tags: [Admin]
 *     responses:
 *       201: { description: Admin created }
 */
// Creating admin accounts is a super-admin-only action. Previously any 'admin'
// could call this AND set role:'super_admin' in the body (mass-assignment),
// escalating themselves to super-admin. Now only a super-admin may register
// accounts, and the controller whitelists the role field.
router.post('/register', superAdminAuthMiddleware, registerAdmin);
/**
 * @swagger
 * /admin/managers:
 *   get:
 *     summary: List all managers
 *     tags: [Admin]
 *     responses:
 *       200: { description: List of managers }
 */
router.get('/managers', adminAuthenticateMiddleware, getManagers);
/**
 * @swagger
 * /admin/dashboard:
 *   get:
 *     summary: Get dashboard statistics
 *     tags: [Admin]
 *     responses:
 *       200: { description: Dashboard stats }
 */
router.get('/dashboard', adminAuthenticateMiddleware, getDashboardStats);
/**
 * @swagger
 * /admin/agent-monitor:
 *   get:
 *     summary: Get real-time agent (manager) monitoring data
 *     tags: [Admin]
 *     responses:
 *       200: { description: Agent monitor data }
 */
router.get('/agent-monitor', adminAuthenticateMiddleware, getAgentMonitorData);
/**
 * @swagger
 * /admin/managers/{managerId}/status:
 *   put:
 *     summary: Update a manager's active status (supervisor only)
 *     tags: [Admin]
 *     parameters:
 *       - in: path
 *         name: managerId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Status updated }
 */
router.put('/managers/:managerId/status', supervisorAuthMiddleware, updateManagerStatus);
/**
 * @swagger
 * /admin/managers/{managerId}/reset-password:
 *   put:
 *     summary: Reset a manager's password (supervisor only)
 *     tags: [Admin]
 *     parameters:
 *       - in: path
 *         name: managerId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Password reset }
 */
router.put('/managers/:managerId/reset-password', supervisorAuthMiddleware, resetManagerPassword);
/**
 * @swagger
 * /admin/managers/{managerId}:
 *   delete:
 *     summary: Delete a manager account (super_admin only)
 *     tags: [Admin]
 *     parameters:
 *       - in: path
 *         name: managerId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Manager deleted }
 */
router.delete('/managers/:managerId', superAdminAuthMiddleware, deleteManager);
/**
 * @swagger
 * /admin/call-logs:
 *   get:
 *     summary: List call logs
 *     tags: [Admin]
 *     responses:
 *       200: { description: Call logs }
 */
router.get('/call-logs', adminAuthenticateMiddleware, getCallLogs);
router.get('/manager-activity-report', adminAuthenticateMiddleware, getManagerActivityReport);

// Recording routes
/**
 * @swagger
 * /admin/recordings:
 *   get:
 *     summary: List recordings
 *     tags: [Admin]
 *     responses:
 *       200: { description: List of recordings }
 */
router.get('/recordings', adminAuthenticateMiddleware, getRecordings);
/**
 * @swagger
 * /admin/recordings/{id}/download:
 *   get:
 *     summary: Download a recording file
 *     tags: [Admin]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Recording file stream }
 */
router.get('/recordings/:id/download', adminAuthenticateMiddleware, downloadRecording);
/**
 * @swagger
 * /admin/recordings/{id}/stream:
 *   get:
 *     summary: Stream a recording for inline playback
 *     tags: [Admin]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Recording stream }
 */
router.get('/recordings/:id/stream', adminAuthenticateMiddleware, streamRecording);
/**
 * @swagger
 * /admin/recordings/{id}:
 *   get:
 *     summary: Get recording details
 *     tags: [Admin]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Recording details }
 *   put:
 *     summary: Update recording metadata
 *     tags: [Admin]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Recording updated }
 *   delete:
 *     summary: Soft-delete a recording
 *     tags: [Admin]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Recording deleted }
 */
router.get('/recordings/:id', adminAuthenticateMiddleware, getRecording);
router.put('/recordings/:id', adminAuthenticateMiddleware, updateRecording);
router.delete('/recordings/:id', adminAuthenticateMiddleware, deleteRecording);
/**
 * @swagger
 * /admin/recordings/sync:
 *   post:
 *     summary: Sync recording statuses from LiveKit egress
 *     tags: [Admin]
 *     responses:
 *       200: { description: Sync complete }
 */
router.post('/recordings/sync', adminAuthenticateMiddleware, syncRecordings);

// Supervisor routes
/**
 * @swagger
 * /admin/active-calls:
 *   get:
 *     summary: List currently active calls (supervisor only)
 *     tags: [Admin]
 *     responses:
 *       200: { description: Active calls }
 */
router.get('/active-calls', supervisorAuthMiddleware, getActiveCalls);

// Supervisor whisper / silent monitoring
/**
 * @swagger
 * /admin/supervisor/whisper-token:
 *   post:
 *     summary: Generate a LiveKit token for supervisor whisper/silent monitoring
 *     tags: [Admin]
 *     responses:
 *       200: { description: Whisper token issued }
 */
router.post('/supervisor/whisper-token', supervisorAuthMiddleware, generateWhisperToken);
/**
 * @swagger
 * /admin/supervisor/whisper-mode:
 *   put:
 *     summary: Toggle whisper mode for a monitored call
 *     tags: [Admin]
 *     responses:
 *       200: { description: Whisper mode toggled }
 *   get:
 *     summary: Get current whisper mode state
 *     tags: [Admin]
 *     responses:
 *       200: { description: Whisper mode state }
 */
router.put('/supervisor/whisper-mode', supervisorAuthMiddleware, toggleWhisperMode);
router.get('/supervisor/whisper-mode', supervisorAuthMiddleware, getWhisperMode);

// Service change request audit log
/**
 * @swagger
 * /admin/change-requests:
 *   get:
 *     summary: List service change request audit log entries
 *     tags: [Admin]
 *     responses:
 *       200: { description: Change requests }
 */
router.get('/change-requests', adminAuthenticateMiddleware, getChangeRequests);

// System Settings
/**
 * @swagger
 * /admin/settings:
 *   get:
 *     summary: Get system settings
 *     tags: [Admin]
 *     responses:
 *       200: { description: System settings }
 *   put:
 *     summary: Update a system setting
 *     tags: [Admin]
 *     responses:
 *       200: { description: Setting updated }
 */
router.get('/settings', adminAuthenticateMiddleware, getSystemSettings);
router.put('/settings', adminAuthenticateMiddleware, updateSystemSetting);

// Security & Audit Logs (super_admin only)
/**
 * @swagger
 * /admin/logs/authentication:
 *   get:
 *     summary: Get authentication audit logs
 *     tags: [Admin]
 *     responses:
 *       200: { description: Authentication logs }
 */
router.get('/logs/authentication', adminAuthenticateMiddleware, getAuthenticationLogs);
/**
 * @swagger
 * /admin/logs/transactions:
 *   get:
 *     summary: Get transaction audit logs
 *     tags: [Admin]
 *     responses:
 *       200: { description: Transaction logs }
 */
router.get('/logs/transactions', adminAuthenticateMiddleware, getTransactionLogs);
/**
 * @swagger
 * /admin/logs/admin-activity:
 *   get:
 *     summary: Get admin activity audit logs
 *     tags: [Admin]
 *     responses:
 *       200: { description: Admin activity logs }
 */
router.get('/logs/admin-activity', adminAuthenticateMiddleware, getAdminActivityLogs);
/**
 * @swagger
 * /admin/security/summary:
 *   get:
 *     summary: Get a security posture summary
 *     tags: [Admin]
 *     responses:
 *       200: { description: Security summary }
 */
router.get('/security/summary', adminAuthenticateMiddleware, getSecuritySummary);

module.exports = router;
