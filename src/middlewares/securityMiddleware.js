/**
 * Security Middleware
 * OWASP Top 10 compliance measures
 */
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { sanitizeRequest, hasSQLInjection, hasXSS } = require('../utils/inputValidation');

// ==================== RATE LIMITING ====================

/**
 * General API rate limiter
 */
const generalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: {
    success: false,
    message: 'Too many requests, please try again later',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.ip ||
           req.connection?.remoteAddress ||
           'unknown';
  }
});

/**
 * Auth endpoints rate limiter (stricter)
 */
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  message: {
    success: false,
    message: 'Too many authentication attempts, please try again after 15 minutes',
    code: 'AUTH_RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    // Rate limit by IP + email combination
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.ip ||
               req.connection?.remoteAddress ||
               'unknown';
    const email = req.body?.email || 'unknown';
    return `${ip}:${email}`;
  }
});

/**
 * OTP rate limiter
 */
const otpRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3, // 3 OTP requests per minute
  message: {
    success: false,
    message: 'Too many OTP requests, please wait before requesting another',
    code: 'OTP_RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});

/**
 * Password reset rate limiter
 */
const passwordResetRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 password reset requests per hour
  message: {
    success: false,
    message: 'Too many password reset attempts, please try again later',
    code: 'PASSWORD_RESET_RATE_LIMIT'
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});

// ==================== SECURITY HEADERS ====================

/**
 * Security headers middleware using Helmet
 */
const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "wss:", "https:"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
});

/**
 * Additional security headers
 */
const additionalSecurityHeaders = (req, res, next) => {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Enable XSS filter
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions policy
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');

  // Cache control for sensitive data
  if (req.path.includes('/api/') && !req.path.includes('/public/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  next();
};

// ==================== INPUT VALIDATION ====================

/**
 * Injection prevention middleware
 */
const injectionPrevention = (req, res, next) => {
  // Check query parameters
  const queryString = JSON.stringify(req.query);
  if (hasSQLInjection(queryString) || hasXSS(queryString)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid query parameters detected',
      code: 'INVALID_INPUT'
    });
  }

  // Check body
  if (req.body) {
    const bodyString = JSON.stringify(req.body);
    if (hasSQLInjection(bodyString)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request content detected',
        code: 'SQL_INJECTION_DETECTED'
      });
    }
    if (hasXSS(bodyString)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request content detected',
        code: 'XSS_DETECTED'
      });
    }
  }

  // Check URL parameters
  const paramsString = JSON.stringify(req.params);
  if (hasSQLInjection(paramsString) || hasXSS(paramsString)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid URL parameters detected',
      code: 'INVALID_INPUT'
    });
  }

  next();
};

// ==================== CORS CONFIGURATION ====================

/**
 * CORS options generator
 */
const getCorsOptions = (allowedOrigins = []) => {
  return {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin) return callback(null, true);

      // Check against whitelist
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    exposedHeaders: ['X-Total-Count', 'X-Page', 'X-Limit'],
    maxAge: 86400 // 24 hours
  };
};

// ==================== REQUEST LOGGING ====================

/**
 * Security request logger
 */
const securityRequestLogger = (req, res, next) => {
  const startTime = Date.now();

  // Log request
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
             req.ip ||
             req.connection?.remoteAddress;

  // Capture response
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;

    // Log suspicious activity
    if (statusCode === 401 || statusCode === 403) {
      console.log(`[SECURITY] Unauthorized access attempt: ${req.method} ${req.originalUrl} | IP: ${ip} | Status: ${statusCode}`);
    }

    if (statusCode === 400) {
      console.log(`[SECURITY] Bad request: ${req.method} ${req.originalUrl} | IP: ${ip}`);
    }

    // Log slow requests (potential DoS)
    if (duration > 10000) {
      console.log(`[SECURITY] Slow request detected: ${req.method} ${req.originalUrl} | Duration: ${duration}ms | IP: ${ip}`);
    }
  });

  next();
};

// ==================== SENSITIVE DATA PROTECTION ====================

/**
 * Mask sensitive data in responses
 */
const maskSensitiveData = (req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = (data) => {
    const masked = maskObject(data);
    return originalJson(masked);
  };

  next();
};

/**
 * Recursively mask sensitive fields in object
 */
const maskObject = (obj) => {
  if (typeof obj !== 'object' || obj === null) return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => maskObject(item));
  }

  const masked = {};
  const sensitiveFields = ['password', 'token', 'secret', 'otp', 'pin', 'cvv', 'ssn', 'nid'];
  const partialMaskFields = ['phone', 'email', 'accountNumber'];

  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();

    if (sensitiveFields.some(field => lowerKey.includes(field))) {
      // Completely mask sensitive fields
      masked[key] = '[REDACTED]';
    } else if (partialMaskFields.some(field => lowerKey.includes(field)) && typeof value === 'string') {
      // Partially mask PII
      masked[key] = partialMask(value, lowerKey);
    } else if (typeof value === 'object') {
      masked[key] = maskObject(value);
    } else {
      masked[key] = value;
    }
  }

  return masked;
};

/**
 * Partially mask a string value
 */
const partialMask = (value, fieldType) => {
  if (!value || typeof value !== 'string') return value;

  if (fieldType.includes('email')) {
    const [local, domain] = value.split('@');
    if (local && domain) {
      return `${local.substring(0, 2)}***@${domain}`;
    }
  }

  if (fieldType.includes('phone')) {
    if (value.length > 6) {
      return value.substring(0, 3) + '***' + value.substring(value.length - 3);
    }
  }

  if (fieldType.includes('account')) {
    if (value.length > 4) {
      return '***' + value.substring(value.length - 4);
    }
  }

  return value;
};

// ==================== BRUTE FORCE PROTECTION ====================

// Store for tracking failed attempts (in production, use Redis)
const failedAttempts = new Map();

/**
 * Brute force protection middleware
 */
const bruteForceProtection = (maxAttempts = 5, windowMs = 15 * 60 * 1000) => {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.ip ||
               req.connection?.remoteAddress;
    const key = `${ip}:${req.body?.email || 'general'}`;

    const now = Date.now();
    const record = failedAttempts.get(key);

    // Clean up old records
    if (record && now - record.firstAttempt > windowMs) {
      failedAttempts.delete(key);
    }

    // Check if blocked
    if (record && record.count >= maxAttempts && now - record.firstAttempt < windowMs) {
      const remainingTime = Math.ceil((windowMs - (now - record.firstAttempt)) / 1000 / 60);
      return res.status(429).json({
        success: false,
        message: `Too many attempts. Please try again in ${remainingTime} minutes`,
        code: 'BRUTE_FORCE_BLOCKED'
      });
    }

    // Store original end to track response
    const originalEnd = res.end;
    res.end = function(chunk, encoding) {
      res.end = originalEnd;

      // If authentication failed, increment counter
      if (res.statusCode === 401) {
        const existing = failedAttempts.get(key) || { count: 0, firstAttempt: now };
        existing.count++;
        if (existing.count === 1) existing.firstAttempt = now;
        failedAttempts.set(key, existing);
      } else if (res.statusCode === 200) {
        // Clear on success
        failedAttempts.delete(key);
      }

      return res.end(chunk, encoding);
    };

    next();
  };
};

module.exports = {
  // Rate Limiters
  generalRateLimiter,
  authRateLimiter,
  otpRateLimiter,
  passwordResetRateLimiter,

  // Security Headers
  securityHeaders,
  additionalSecurityHeaders,

  // Input Validation
  injectionPrevention,

  // CORS
  getCorsOptions,

  // Logging
  securityRequestLogger,

  // Data Protection
  maskSensitiveData,

  // Brute Force
  bruteForceProtection
};
