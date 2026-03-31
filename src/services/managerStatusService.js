const Redis = require('ioredis');

// Redis connection for manager status persistence
const redis = new Redis({
  host: process.env.REDIS_HOST || 'vbrm-redis',
  port: 6379,
  password: process.env.REDIS_PASSWORD || 'VbrmRedis2024Secure',
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const STATUS_KEY_PREFIX = 'manager:status:';
const STATUS_TTL = 86400; // 24 hours

/**
 * Save manager status to Redis
 * @param {string} managerEmail - Manager email
 * @param {string} status - Manager status (online, busy, break, etc.)
 * @returns {Promise<boolean>}
 */
async function saveManagerStatus(managerEmail, status) {
  try {
    const key = `${STATUS_KEY_PREFIX}${managerEmail}`;
    await redis.setex(key, STATUS_TTL, status);
    console.log(`💾 Saved manager status: ${managerEmail} → ${status}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to save manager status for ${managerEmail}:`, error);
    return false;
  }
}

/**
 * Get manager status from Redis
 * @param {string} managerEmail - Manager email
 * @returns {Promise<string|null>} Status or null if not found
 */
async function getManagerStatus(managerEmail) {
  try {
    const key = `${STATUS_KEY_PREFIX}${managerEmail}`;
    const status = await redis.get(key);
    if (status) {
      console.log(`📥 Retrieved manager status: ${managerEmail} → ${status}`);
    }
    return status;
  } catch (error) {
    console.error(`❌ Failed to get manager status for ${managerEmail}:`, error);
    return null;
  }
}

/**
 * Delete manager status from Redis (when manager goes offline)
 * @param {string} managerEmail - Manager email
 * @returns {Promise<boolean>}
 */
async function deleteManagerStatus(managerEmail) {
  try {
    const key = `${STATUS_KEY_PREFIX}${managerEmail}`;
    await redis.del(key);
    console.log(`🗑️ Deleted manager status: ${managerEmail}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to delete manager status for ${managerEmail}:`, error);
    return false;
  }
}

/**
 * Get all manager statuses
 * @returns {Promise<Object>} Map of email -> status
 */
async function getAllManagerStatuses() {
  try {
    const pattern = `${STATUS_KEY_PREFIX}*`;
    const keys = await redis.keys(pattern);
    const statuses = {};
    
    for (const key of keys) {
      const email = key.replace(STATUS_KEY_PREFIX, '');
      const status = await redis.get(key);
      if (status) {
        statuses[email] = status;
      }
    }
    
    return statuses;
  } catch (error) {
    console.error('❌ Failed to get all manager statuses:', error);
    return {};
  }
}

module.exports = {
  saveManagerStatus,
  getManagerStatus,
  deleteManagerStatus,
  getAllManagerStatuses
};
