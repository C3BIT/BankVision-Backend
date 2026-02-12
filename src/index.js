const express = require("express");
const cors = require("cors");
const path = require("path");
const cookieParser = require("cookie-parser");
require('dotenv').config()
const routes = require("./routes/index.js");
const { PORT } = require("./configs/variables.js");
const bodyParser = require("body-parser");
const { responseHandler } = require("./middlewares/responseHandler.js");
const { requestIdMiddleware } = require("./middlewares/requestIdMiddleware.js");
const { initializeWebSocket } = require("./services/websocketService.js");
const app = express();

// CORS configuration - whitelist allowed origins only
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim())
  : [];

console.log('🌐 Allowed CORS Origins:', allowedOrigins);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`⚠️ CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'token', 'X-Requested-With', 'Accept', 'Origin', 'X-Request-ID', 'X-Correlation-ID'],
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'Content-Type', 'X-Request-ID'],
  credentials: true,
  maxAge: 86400, // 24 hours
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Security Headers (HSTS, CSP, etc.)
app.use((req, res, next) => {
  // HSTS - Force HTTPS for 1 year
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');

  // Content Security Policy (no unsafe-inline)
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self'; " +
    "img-src 'self' data: https:; " +
    "font-src 'self' data:; " +
    "connect-src 'self' wss: https:; " +
    "media-src 'self'; " +
    "object-src 'none'; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self';"
  );

  // Additional security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  next();
});

app.use(cookieParser()); // Parse cookies for httpOnly token support
app.use(requestIdMiddleware); // Add correlation ID for distributed tracing

// Debug logging for ALL requests
app.use((req, res, next) => {
  if (req.path.includes('/cbs/')) {
    console.log(`📥 CBS Request: ${req.method} ${req.path}`);
    console.log(`  Origin: ${req.headers.origin || 'none'}`);
    console.log(`  Cookies: ${req.cookies ? Object.keys(req.cookies).join(', ') : 'none'}`);
    console.log(`  Auth header: ${req.headers.authorization ? 'present' : 'missing'}`);
  }
  next();
});

app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(responseHandler());
// Serve static files from uploads directory
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));
app.use("/api", routes);
// Bind to all interfaces inside container (Docker port mapping handles external security)
// Setup Bull Board for queue monitoring
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const { callQueue } = require('./services/callQueueService');

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [new BullMQAdapter(callQueue)],
  serverAdapter: serverAdapter,
});

// Mount Bull Board dashboard with admin authentication
const { adminAuthenticateMiddleware } = require('./middlewares/adminAuthMiddleware');
app.use('/admin/queues', adminAuthenticateMiddleware, serverAdapter.getRouter());
console.log('📊 Bull Board dashboard available at /admin/queues (protected)');

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡️[server]: Server is running at 0.0.0.0:${PORT}`);
});

const io = initializeWebSocket(server);

// NOTE: BullMQ worker is disabled for broadcast routing
// With the new smart broadcast approach, queue routing is handled by
// checkQueueAndRouteCall() which broadcasts to multiple managers simultaneously.
// The worker auto-routes to a single manager which conflicts with broadcasting.
// BullMQ is still used for queue storage, priority, and persistence.

// Uncomment below if you want background job processing instead of broadcast:
// const { startCallQueueWorker } = require('./services/callQueueWorker');
// startCallQueueWorker(io);

// Start periodic tasks for queue management
const { escalateOldCalls, cleanupDisconnectedCustomers } = require('./services/callQueueService');

// Escalate calls waiting > 5 minutes every 30 seconds
setInterval(() => {
  escalateOldCalls(io);
}, 30000);

// Cleanup disconnected customers every 2 minutes
setInterval(() => {
  cleanupDisconnectedCustomers(io);
}, 120000);

console.log('✅ BullMQ queue monitoring tasks started');

// Make io accessible from Express app for controllers
app.set('io', io);
module.exports = server;

