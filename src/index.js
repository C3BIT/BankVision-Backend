const express = require("express");
const cors = require("cors");
const path = require("path");
const cookieParser = require("cookie-parser");
require('dotenv').config({ override: true })
const routes = require("./routes/index.js");
const { PORT } = require("./configs/variables.js");
const bodyParser = require("body-parser");
const { responseHandler } = require("./middlewares/responseHandler.js");
const { requestIdMiddleware } = require("./middlewares/requestIdMiddleware.js");
const { base64Codec } = require("./middlewares/base64Codec.js");
const { initializeWebSocket } = require("./services/websocketService.js");
const app = express();

// Trust reverse proxy (Coolify/Traefik) for HTTPS/Secure cookies
app.set('trust proxy', 1);
// Don't disclose the Express/Node stack via the X-Powered-By header
app.disable('x-powered-by');

// Database Synchronization
const models = require("./models/index.js");
const { syncAllCriticalModels } = require("./utils/dbSync.js");
const sequelize = models.sequelize;

(async () => {
  try {
    await sequelize.authenticate();
    console.log("✅ Database connected successfully.");
    await sequelize.sync({ force: false });
    console.log("✅ Tables synced successfully.");

    // Safety check for missing columns (fixes "Unknown column" errors)
    await syncAllCriticalModels(sequelize);

    // Self-healing: Sync stuck recordings (from previous crashes/restarts)
    const { syncRecordings } = require("./services/recordingService.js");
    syncRecordings().catch(err => console.error("⚠️ Initial recording sync failed:", err.message));
  } catch (error) {
    console.error("❌ Database initialization failed:", error);
  }
})();

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
      // Return null, false to reject the origin without throwing a middleware error
      callback(null, false);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'token', 'X-Requested-With', 'Accept', 'Origin', 'X-Request-ID', 'X-Correlation-ID'],
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'Content-Type', 'Content-Range', 'Accept-Ranges', 'X-Request-ID'],
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


app.use(bodyParser.urlencoded({ extended: false, limit: '1mb' }));
// LiveKit's webhook signature covers the exact raw request bytes, so stash
// them before express.json() re-serializes into an object - the webhook
// controller verifies against req.rawBody, not the parsed req.body.
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(responseHandler());
// Serve static files from uploads directory. Extensions are now locked to a
// safe raster-image/PDF allowlist at upload time (see spaceService.js), but
// nosniff is added as defense-in-depth against MIME-sniffing based XSS.
app.use("/uploads", express.static(path.join(__dirname, "../uploads"), {
  setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff"),
}));
// API documentation (Swagger UI). Kept outside /api so the base64 codec
// below never touches it.
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./configs/swagger.js");
app.get("/api-docs.json", (req, res) => res.json(swaggerSpec));
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Base64 request/response codec: scoped to /api only, so it never touches
// /uploads (raw file bytes) or /admin/queues (Bull Board UI). Webhook and
// health-check paths are excluded inside the middleware itself since those
// are consumed by external systems/infra that expect plain JSON.
app.use("/api", base64Codec, routes);
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

// Hydrate this pod's local manager/customer presence cache from Redis (and
// subscribe to cross-pod updates) before accepting any socket connections —
// see presenceSync.js for why this exists.
const { initPresenceSync } = require("./utils/presenceSync.js");
initPresenceSync().catch((err) =>
  console.error("⚠️ presenceSync initialization failed:", err.message)
);

// Same idea as presenceSync above, for activeCustomerCalls/activeSupervisors
// (see callStateSync.js for why these needed their own module rather than
// reusing presenceSync's generic key/value cache).
const { initCallStateSync } = require("./utils/callStateSync.js");
const { activeCustomerCalls, activeSupervisors } = require("./services/socketHandler.js");
initCallStateSync(activeCustomerCalls, activeSupervisors).catch((err) =>
  console.error("⚠️ callStateSync initialization failed:", err.message)
);

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

// Check for due scheduled callbacks every minute
const { checkDueScheduledCalls } = require('./services/scheduledCallService');
setInterval(() => {
  checkDueScheduledCalls(io);
}, 60000);

console.log('✅ BullMQ queue monitoring tasks started');

// Make io accessible from Express app for controllers
app.set('io', io);
module.exports = server;

