/**
 * Request ID Middleware - Add correlation ID to all requests for distributed tracing
 * Useful for tracking requests across microservices and debugging production issues
 */

const crypto = require('crypto');

/**
 * Generate a unique request ID (UUID v4 format)
 * @returns {string} - UUID v4 request ID
 */
const generateRequestId = () => {
  return crypto.randomUUID();
};

/**
 * Middleware to add request ID to all incoming requests
 * Accepts existing request ID from client (X-Request-ID header) or generates new one
 */
const requestIdMiddleware = (req, res, next) => {
  // Check if client already sent a request ID (for distributed tracing)
  const existingRequestId = req.headers['x-request-id'] || req.headers['x-correlation-id'];

  // Use existing ID or generate new one
  const requestId = existingRequestId || generateRequestId();

  // Attach to request object for use in controllers/services
  req.requestId = requestId;

  // Add to response headers so client can see it
  res.setHeader('X-Request-ID', requestId);

  // Add to logs (if using structured logging like Winston)
  req.log = {
    requestId,
    method: req.method,
    url: req.url,
    ip: req.ip || req.connection?.remoteAddress,
    userAgent: req.headers['user-agent']
  };

  next();
};

/**
 * Helper function to get request ID from request object
 * @param {object} req - Express request object
 * @returns {string} - Request ID
 */
const getRequestId = (req) => {
  return req.requestId || 'unknown';
};

module.exports = {
  requestIdMiddleware,
  generateRequestId,
  getRequestId
};
