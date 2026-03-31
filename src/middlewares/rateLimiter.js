/**
 * Rate Limiting Middleware using Redis
 * Prevents brute force attacks and API abuse
 */

const { redisClient } = require('../configs/redis');

/**
 * Create a rate limiter middleware
 * @param {Object} options - Rate limiter options
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.maxRequests - Maximum requests in window
 * @param {string} options.keyPrefix - Redis key prefix
 * @param {Function} options.keyGenerator - Function to generate unique key (default: IP)
 * @param {Function} options.skipSuccessfulRequests - Skip counting successful requests
 * @returns {Function} - Express middleware
 */
const createRateLimiter = (options = {}) => {
  const {
    windowMs = 15 * 60 * 1000, // 15 minutes
    maxRequests = 100,
    keyPrefix = 'rate_limit:',
    keyGenerator = (req) => {
      // Use X-Forwarded-For header if behind proxy, otherwise use req.ip
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
      return `${ip}`;
    },
    skipSuccessfulRequests = false,
    failOpen = false, // If false (default), deny requests when Redis is unavailable
    message = 'Too many requests, please try again later.'
  } = options;

  return async (req, res, next) => {
    try {
      const key = `${keyPrefix}${keyGenerator(req)}`;
      const windowSeconds = Math.floor(windowMs / 1000);

      // Get current count
      const current = await redisClient.get(key);
      const count = current ? parseInt(current, 10) : 0;

      // Check if limit exceeded
      if (count >= maxRequests) {
        const ttl = await redisClient.ttl(key);
        const retryAfter = ttl > 0 ? ttl : windowSeconds;

        return res.status(429).json({
          success: false,
          message: message,
          retryAfter: retryAfter,
          limit: maxRequests,
          remaining: 0
        });
      }

      // Increment counter
      const newCount = await redisClient.incr(key);

      // Set TTL on first request
      if (newCount === 1) {
        await redisClient.expire(key, windowSeconds);
      }

      // Add rate limit headers
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - newCount));
      res.setHeader('X-RateLimit-Reset', Date.now() + windowSeconds * 1000);

      // If skipSuccessfulRequests, decrement on successful response
      if (skipSuccessfulRequests) {
        const originalSend = res.send;
        res.send = function(data) {
          if (res.statusCode < 400) {
            redisClient.decr(key).catch(err => {
              console.error('Error decrementing rate limit:', err);
            });
          }
          return originalSend.call(this, data);
        };
      }

      next();
    } catch (error) {
      console.error('Rate limiter error:', error);
      if (failOpen) {
        // Non-sensitive endpoints: allow through when Redis is down
        next();
      } else {
        // Security-sensitive endpoints: deny when Redis is unavailable to prevent brute force
        return res.status(503).json({
          success: false,
          message: 'Service temporarily unavailable, please try again shortly.'
        });
      }
    }
  };
};

/**
 * General API rate limiter (100 requests per 15 minutes)
 */
const apiRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 100,
  keyPrefix: 'rate_limit:api:',
  failOpen: true, // General API — non-critical, allow through on Redis failure
  message: 'Too many API requests from this IP, please try again later.'
});

/**
 * Auth endpoints rate limiter (10 requests per 15 minutes, skip on success)
 */
const authRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 10,
  keyPrefix: 'rate_limit:auth:',
  keyGenerator: (req) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const email = req.body?.email || req.body?.phone || 'unknown';
    return `${ip}:${email}`;
  },
  skipSuccessfulRequests: true,
  message: 'Too many login attempts, please try again later.'
});

/**
 * OTP endpoints rate limiter (3 requests per minute)
 */
const otpRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 3,
  keyPrefix: 'rate_limit:otp:',
  keyGenerator: (req) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const phone = req.body?.phone || req.body?.email || 'unknown';
    return `${ip}:${phone}`;
  },
  message: 'Too many OTP requests, please wait before trying again.'
});

/**
 * Password reset rate limiter (5 requests per hour)
 */
const passwordResetRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  maxRequests: 5,
  keyPrefix: 'rate_limit:password_reset:',
  keyGenerator: (req) => {
    const email = req.body?.email || 'unknown';
    return email;
  },
  message: 'Too many password reset requests, please try again later.'
});

/**
 * Brute force protection middleware
 * Tracks failed login attempts and locks account after threshold
 */
const bruteForceProtection = async (req, res, next) => {
  try {
    const identifier = req.body?.email || req.body?.phone;
    if (!identifier) {
      return next();
    }

    const key = `brute_force:${identifier}`;
    const maxAttempts = 5;
    const lockDuration = 15 * 60; // 15 minutes in seconds

    // Check if account is locked
    const attempts = await redisClient.get(key);
    const attemptCount = attempts ? parseInt(attempts, 10) : 0;

    if (attemptCount >= maxAttempts) {
      const ttl = await redisClient.ttl(key);
      return res.status(429).json({
        success: false,
        message: 'Account temporarily locked due to too many failed attempts.',
        retryAfter: ttl,
        lockedUntil: new Date(Date.now() + ttl * 1000)
      });
    }

    // Track failed attempt (will be cleared on successful login)
    req.bruteForceKey = key;
    req.bruteForceAttempts = attemptCount;

    next();
  } catch (error) {
    console.error('Brute force protection error:', error);
    // Fail closed — deny on Redis error to prevent brute force during outage
    return res.status(503).json({
      success: false,
      message: 'Service temporarily unavailable, please try again shortly.'
    });
  }
};

/**
 * Clear brute force attempts on successful login
 */
const clearBruteForceAttempts = async (identifier) => {
  try {
    const key = `brute_force:${identifier}`;
    await redisClient.del(key);
  } catch (error) {
    console.error('Error clearing brute force attempts:', error);
  }
};

/**
 * Increment brute force attempts on failed login
 */
const incrementBruteForceAttempts = async (identifier) => {
  try {
    const key = `brute_force:${identifier}`;
    const lockDuration = 15 * 60; // 15 minutes

    const newCount = await redisClient.incr(key);

    // Set TTL on first attempt
    if (newCount === 1) {
      await redisClient.expire(key, lockDuration);
    }

    return newCount;
  } catch (error) {
    console.error('Error incrementing brute force attempts:', error);
    return 0;
  }
};

module.exports = {
  createRateLimiter,
  apiRateLimiter,
  authRateLimiter,
  otpRateLimiter,
  passwordResetRateLimiter,
  bruteForceProtection,
  clearBruteForceAttempts,
  incrementBruteForceAttempts
};
