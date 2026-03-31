/**
 * Session Manager - Prevents multiple active sessions per user
 * Uses Redis for distributed session storage (multi-server support)
 */

const { redisClient } = require('../configs/redis');

const SESSION_PREFIX = 'session:';
const SESSION_TTL = 8 * 60 * 60; // 8 hours in seconds

/**
 * Create or update a session for a user
 * @param {string} userId - User ID
 * @param {string} token - JWT token
 * @param {object} metadata - Session metadata
 * @returns {Promise<object>} - Session info
 */
const createSession = async (userId, token, metadata = {}) => {
  const session = {
    userId,
    token,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    userAgent: metadata.userAgent || 'Unknown',
    ipAddress: metadata.ipAddress || 'Unknown',
    deviceId: metadata.deviceId || null,
    socketId: metadata.socketId || null
  };

  const key = `${SESSION_PREFIX}${userId}`;
  await redisClient.setex(key, SESSION_TTL, JSON.stringify(session));

  return session;
};

/**
 * Update socket ID for a session
 * @param {string} userId - User ID
 * @param {string} socketId - Socket ID
 * @returns {Promise<void>}
 */
const updateSessionSocketId = async (userId, socketId) => {
  const session = await getSession(userId);
  if (session) {
    session.socketId = socketId;
    session.lastActivity = Date.now();
    const key = `${SESSION_PREFIX}${userId}`;
    await redisClient.setex(key, SESSION_TTL, JSON.stringify(session));
  }
};

/**
 * Get active session for a user
 * @param {string} userId - User ID
 * @returns {Promise<object|null>} - Session info or null
 */
const getSession = async (userId) => {
  try {
    const key = `${SESSION_PREFIX}${userId}`;
    const sessionData = await redisClient.get(key);
    return sessionData ? JSON.parse(sessionData) : null;
  } catch (error) {
    console.error('Error getting session from Redis:', error);
    return null;
  }
};

/**
 * Check if user has an active session with different token
 * @param {string} userId - User ID
 * @param {string} currentToken - Current token to compare
 * @returns {Promise<boolean>} - True if another session exists
 */
const hasOtherActiveSession = async (userId, currentToken) => {
  const session = await getSession(userId);
  if (!session) return false;

  // If same token, it's the same session
  if (session.token === currentToken) return false;

  // Check if session is still valid (TTL handled by Redis)
  const sessionAge = Date.now() - session.createdAt;
  const maxAge = SESSION_TTL * 1000; // Convert to milliseconds

  if (sessionAge > maxAge) {
    // Session should have expired (Redis will handle cleanup)
    return false;
  }

  return true;
};

/**
 * Invalidate a user's session (force logout)
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} - True if session was invalidated
 */
const invalidateSession = async (userId) => {
  try {
    const key = `${SESSION_PREFIX}${userId}`;
    const result = await redisClient.del(key);
    return result > 0;
  } catch (error) {
    console.error('Error invalidating session:', error);
    return false;
  }
};

/**
 * Update session activity timestamp
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
const updateSessionActivity = async (userId) => {
  const session = await getSession(userId);
  if (session) {
    session.lastActivity = Date.now();
    const key = `${SESSION_PREFIX}${userId}`;
    await redisClient.setex(key, SESSION_TTL, JSON.stringify(session));
  }
};

/**
 * Get all active sessions (for admin monitoring)
 * @returns {Promise<Array>} - Array of active sessions
 */
const getAllSessions = async () => {
  try {
    const keys = await redisClient.keys(`${SESSION_PREFIX}*`);
    const sessions = [];

    for (const key of keys) {
      const sessionData = await redisClient.get(key);
      if (sessionData) {
        const session = JSON.parse(sessionData);
        sessions.push({
          userId: session.userId,
          createdAt: session.createdAt,
          lastActivity: session.lastActivity,
          userAgent: session.userAgent,
          ipAddress: session.ipAddress,
          deviceId: session.deviceId,
          socketId: session.socketId
          // Don't expose the token
        });
      }
    }

    return sessions;
  } catch (error) {
    console.error('Error getting all sessions:', error);
    return [];
  }
};

/**
 * Clean up expired sessions (handled automatically by Redis TTL)
 * This function is kept for compatibility but Redis handles expiry
 * @param {number} maxAge - Maximum session age (ignored, using Redis TTL)
 * @returns {Promise<void>}
 */
const cleanupExpiredSessions = async (maxAge) => {
  // Redis automatically expires keys based on TTL
  console.log('✅ Session cleanup handled by Redis TTL');
};

module.exports = {
  createSession,
  getSession,
  hasOtherActiveSession,
  invalidateSession,
  updateSessionActivity,
  updateSessionSocketId,
  getAllSessions,
  cleanupExpiredSessions
};
