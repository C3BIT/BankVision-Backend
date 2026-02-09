/**
 * Comprehensive Input Validation & Sanitization
 * OWASP compliant input handling
 */
const Joi = require('joi');
const validator = require('validator');

// Common regex patterns
const PATTERNS = {
  phone: /^01[3-9]\d{8}$/,  // Bangladesh phone format
  accountNumber: /^\d{10,16}$/,
  nid: /^\d{10}$|^\d{13}$|^\d{17}$/,  // 10, 13, or 17 digit NID
  otp: /^\d{4,6}$/,
  alphanumeric: /^[a-zA-Z0-9]+$/,
  alphanumericSpace: /^[a-zA-Z0-9\s]+$/,
  name: /^[a-zA-Z\s\-'.]+$/,
  noScript: /<script|javascript:|on\w+=/i,
  sqlInjection: /('|"|;|--|\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE|TRUNCATE)\b)/i
};

// Dangerous characters to escape
const DANGEROUS_CHARS = {
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
  '\\': '&#x5C;',
  '`': '&#x60;'
};

/**
 * Sanitize string input - escape dangerous characters
 */
const sanitizeString = (input) => {
  if (typeof input !== 'string') return input;

  // Trim whitespace
  let sanitized = input.trim();

  // Remove null bytes
  sanitized = sanitized.replace(/\0/g, '');

  // Escape dangerous characters
  Object.keys(DANGEROUS_CHARS).forEach(char => {
    sanitized = sanitized.replace(new RegExp(char, 'g'), DANGEROUS_CHARS[char]);
  });

  return sanitized;
};

/**
 * Deep sanitize an object
 */
const sanitizeObject = (obj) => {
  if (typeof obj !== 'object' || obj === null) {
    return typeof obj === 'string' ? sanitizeString(obj) : obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item));
  }

  const sanitized = {};
  for (const key of Object.keys(obj)) {
    sanitized[sanitizeString(key)] = sanitizeObject(obj[key]);
  }
  return sanitized;
};

/**
 * Check for potential SQL injection
 */
const hasSQLInjection = (input) => {
  if (typeof input !== 'string') return false;
  return PATTERNS.sqlInjection.test(input);
};

/**
 * Check for potential XSS
 */
const hasXSS = (input) => {
  if (typeof input !== 'string') return false;
  return PATTERNS.noScript.test(input);
};

/**
 * Validate and sanitize phone number
 */
const validatePhone = (phone) => {
  if (!phone || typeof phone !== 'string') {
    return { valid: false, error: 'Phone number is required' };
  }

  // Remove any non-digit characters
  const cleaned = phone.replace(/\D/g, '');

  // Check Bangladesh phone format
  if (!PATTERNS.phone.test(cleaned)) {
    return { valid: false, error: 'Invalid phone number format. Must be a valid Bangladesh number (01XXXXXXXXX)' };
  }

  return { valid: true, value: cleaned };
};

/**
 * Validate email
 */
const validateEmail = (email) => {
  if (!email || typeof email !== 'string') {
    return { valid: false, error: 'Email is required' };
  }

  const cleaned = email.trim().toLowerCase();

  if (!validator.isEmail(cleaned)) {
    return { valid: false, error: 'Invalid email format' };
  }

  if (cleaned.length > 254) {
    return { valid: false, error: 'Email too long' };
  }

  return { valid: true, value: cleaned };
};

/**
 * Validate name
 */
const validateName = (name, fieldName = 'Name') => {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: `${fieldName} is required` };
  }

  const cleaned = name.trim();

  if (cleaned.length < 2) {
    return { valid: false, error: `${fieldName} must be at least 2 characters` };
  }

  if (cleaned.length > 100) {
    return { valid: false, error: `${fieldName} must be less than 100 characters` };
  }

  if (!PATTERNS.name.test(cleaned)) {
    return { valid: false, error: `${fieldName} contains invalid characters` };
  }

  if (hasXSS(cleaned) || hasSQLInjection(cleaned)) {
    return { valid: false, error: `${fieldName} contains invalid content` };
  }

  return { valid: true, value: sanitizeString(cleaned) };
};

/**
 * Validate account number
 */
const validateAccountNumber = (accountNumber) => {
  if (!accountNumber || typeof accountNumber !== 'string') {
    return { valid: false, error: 'Account number is required' };
  }

  const cleaned = accountNumber.replace(/\D/g, '');

  if (!PATTERNS.accountNumber.test(cleaned)) {
    return { valid: false, error: 'Invalid account number format' };
  }

  return { valid: true, value: cleaned };
};

/**
 * Validate OTP
 */
const validateOTP = (otp) => {
  if (!otp || typeof otp !== 'string') {
    return { valid: false, error: 'OTP is required' };
  }

  const cleaned = otp.replace(/\D/g, '');

  if (!PATTERNS.otp.test(cleaned)) {
    return { valid: false, error: 'Invalid OTP format' };
  }

  return { valid: true, value: cleaned };
};

/**
 * Validate NID
 */
const validateNID = (nid) => {
  if (!nid || typeof nid !== 'string') {
    return { valid: false, error: 'NID is required' };
  }

  const cleaned = nid.replace(/\D/g, '');

  if (!PATTERNS.nid.test(cleaned)) {
    return { valid: false, error: 'Invalid NID format. Must be 10, 13, or 17 digits' };
  }

  return { valid: true, value: cleaned };
};

/**
 * Validate address
 */
const validateAddress = (address) => {
  if (!address || typeof address !== 'string') {
    return { valid: false, error: 'Address is required' };
  }

  const cleaned = address.trim();

  if (cleaned.length < 10) {
    return { valid: false, error: 'Address must be at least 10 characters' };
  }

  if (cleaned.length > 500) {
    return { valid: false, error: 'Address must be less than 500 characters' };
  }

  if (hasXSS(cleaned) || hasSQLInjection(cleaned)) {
    return { valid: false, error: 'Address contains invalid content' };
  }

  return { valid: true, value: sanitizeString(cleaned) };
};

/**
 * Validate UUID
 */
const validateUUID = (uuid, fieldName = 'ID') => {
  if (!uuid || typeof uuid !== 'string') {
    return { valid: false, error: `${fieldName} is required` };
  }

  if (!validator.isUUID(uuid)) {
    return { valid: false, error: `Invalid ${fieldName} format` };
  }

  return { valid: true, value: uuid };
};

/**
 * Validate date
 */
const validateDate = (date, fieldName = 'Date') => {
  if (!date) {
    return { valid: false, error: `${fieldName} is required` };
  }

  const parsed = new Date(date);

  if (isNaN(parsed.getTime())) {
    return { valid: false, error: `Invalid ${fieldName} format` };
  }

  return { valid: true, value: parsed };
};

/**
 * Validate pagination params
 */
const validatePagination = (page, limit) => {
  const validPage = Math.max(1, parseInt(page) || 1);
  const validLimit = Math.min(100, Math.max(1, parseInt(limit) || 20));

  return { page: validPage, limit: validLimit };
};

// Enhanced Joi schemas
const schemas = {
  // Manager schemas
  managerRegistration: Joi.object({
    name: Joi.string().min(2).max(50).pattern(PATTERNS.name).required()
      .messages({
        'string.pattern.base': 'Name contains invalid characters',
        'string.min': 'Name must be at least 2 characters',
        'string.max': 'Name must be less than 50 characters'
      }),
    email: Joi.string().email().max(100).required(),
    password: Joi.string().min(8).max(128).required()
      .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#^()_+=\-]).{8,}$/)
      .messages({
        'string.pattern.base': 'Password must contain uppercase, lowercase, number, and special character'
      })
  }),

  managerLogin: Joi.object({
    email: Joi.string().email().max(100).required(),
    password: Joi.string().min(1).max(128).required(),
    forceLogin: Joi.boolean().optional()
  }),

  // Customer schemas
  customerPhone: Joi.object({
    phone: Joi.string().pattern(PATTERNS.phone).required()
      .messages({
        'string.pattern.base': 'Invalid Bangladesh phone number format'
      })
  }),

  otpVerification: Joi.object({
    phone: Joi.string().pattern(PATTERNS.phone).optional(),
    email: Joi.string().email().optional(),
    otp: Joi.string().pattern(PATTERNS.otp).required()
      .messages({
        'string.pattern.base': 'OTP must be 4-6 digits'
      })
  }).or('phone', 'email'),

  // Service request schemas
  phoneChange: Joi.object({
    accountNumber: Joi.string().pattern(PATTERNS.accountNumber).required(),
    oldPhone: Joi.string().pattern(PATTERNS.phone).required(),
    newPhone: Joi.string().pattern(PATTERNS.phone).required(),
    otp: Joi.string().pattern(PATTERNS.otp).required()
  }),

  emailChange: Joi.object({
    accountNumber: Joi.string().pattern(PATTERNS.accountNumber).required(),
    newEmail: Joi.string().email().max(100).required(),
    otp: Joi.string().pattern(PATTERNS.otp).required()
  }),

  addressChange: Joi.object({
    accountNumber: Joi.string().pattern(PATTERNS.accountNumber).required(),
    newAddress: Joi.string().min(10).max(500).required(),
    otp: Joi.string().pattern(PATTERNS.otp).required()
  }),

  // Admin schemas
  adminLogin: Joi.object({
    email: Joi.string().email().max(100).required(),
    password: Joi.string().min(1).max(128).required()
  }),

  adminCreate: Joi.object({
    name: Joi.string().min(2).max(100).pattern(PATTERNS.name).required(),
    email: Joi.string().email().max(100).required(),
    password: Joi.string().min(8).max(128).required(),
    role: Joi.string().valid('super_admin', 'admin', 'supervisor').required()
  }),

  // Feedback schema
  feedback: Joi.object({
    callLogId: Joi.string().uuid().optional(),
    rating: Joi.number().integer().min(1).max(5).required(),
    comment: Joi.string().max(1000).optional(),
    customerPhone: Joi.string().pattern(PATTERNS.phone).required()
  }),

  // Search/Filter schemas
  dateRange: Joi.object({
    startDate: Joi.date().iso().required(),
    endDate: Joi.date().iso().min(Joi.ref('startDate')).required()
  }),

  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20)
  })
};

/**
 * Express middleware for request validation
 */
const validateRequest = (schemaName) => {
  return (req, res, next) => {
    const schema = schemas[schemaName];

    if (!schema) {
      return res.status(500).json({
        success: false,
        message: 'Invalid validation schema'
      });
    }

    // Sanitize request body first
    req.body = sanitizeObject(req.body);

    // Check for obvious injection attempts
    const bodyString = JSON.stringify(req.body);
    if (hasSQLInjection(bodyString)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request content detected',
        code: 'INVALID_INPUT'
      });
    }

    if (hasXSS(bodyString)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request content detected',
        code: 'INVALID_INPUT'
      });
    }

    // Validate against schema
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }));

      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors
      });
    }

    req.validatedBody = value;
    next();
  };
};

/**
 * Sanitization middleware
 */
const sanitizeRequest = (req, res, next) => {
  if (req.body) {
    req.body = sanitizeObject(req.body);
  }
  if (req.query) {
    req.query = sanitizeObject(req.query);
  }
  if (req.params) {
    req.params = sanitizeObject(req.params);
  }
  next();
};

module.exports = {
  // Validation functions
  validatePhone,
  validateEmail,
  validateName,
  validateAccountNumber,
  validateOTP,
  validateNID,
  validateAddress,
  validateUUID,
  validateDate,
  validatePagination,

  // Sanitization functions
  sanitizeString,
  sanitizeObject,

  // Security checks
  hasSQLInjection,
  hasXSS,

  // Schemas
  schemas,

  // Middleware
  validateRequest,
  sanitizeRequest,

  // Patterns for external use
  PATTERNS
};
