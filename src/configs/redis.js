const Redis = require('ioredis');

const { REDIS_HOST, REDIS_PORT, REDIS_PASSWORD } = require('./variables');

// Create Redis client with connection pooling and retry strategy
const redisClient = new Redis({
  host: REDIS_HOST || 'localhost',
  port: REDIS_PORT || 6379,
  password: REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    console.log(`⚠️ Redis reconnecting... attempt ${times}, delay ${delay}ms`);
    return delay;
  },
  reconnectOnError(err) {
    console.error('❌ Redis reconnect on error:', err.message);
    return true;
  },
  lazyConnect: false,
  enableReadyCheck: true,
  enableOfflineQueue: true,
});

redisClient.on('connect', () => {
  console.log('✅ Redis connected successfully');
});

redisClient.on('error', (err) => {
  console.error('❌ Redis error:', err.message);
});

redisClient.on('ready', () => {
  console.log('✅ Redis is ready to accept commands');
});

redisClient.on('close', () => {
  console.warn('⚠️ Redis connection closed');
});

redisClient.on('reconnecting', () => {
  console.log('🔄 Redis reconnecting...');
});

module.exports = { redisClient };
