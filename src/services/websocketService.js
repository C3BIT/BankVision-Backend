const socketIo = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const Redis = require("ioredis");
const { handleSocketConnection, getActiveCallsData, getActiveCallLocalRaw } = require("./socketHandler");
const { socketAuthMiddleware } = require("../middlewares/socketAuth");

const initializeWebSocket = (server) => {
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
    : [];

  const io = socketIo(server, {
    cors: {
      origin: allowedOrigins.length > 0 ? allowedOrigins : false,
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // Redis adapter — broadcasts socket events across all backend replicas.
  // Requires two separate ioredis connections: one publisher, one subscriber.
  const redisOpts = {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: false,
  };
  const pubClient = new Redis(redisOpts);
  const subClient = pubClient.duplicate();
  io.adapter(createAdapter(pubClient, subClient));

  io.use(socketAuthMiddleware);

  // Answers cross-pod requests (see getActiveCallsDataCluster in
  // socketHandler.js) for this pod's local in-memory active calls.
  io.on("get-active-calls-local", (callback) => {
    callback(getActiveCallsData());
  });

  // Answers cross-pod requests (see ensureLocalActiveCall in socketHandler.js)
  // for a single customer's locally-held active call, if this pod has it.
  io.on("get-active-call-local", (normalizedPhone, callback) => {
    callback(getActiveCallLocalRaw(normalizedPhone));
  });

  io.on("connection", (socket) => {
    handleSocketConnection(socket, io);
  });
  return io;
};

module.exports = { initializeWebSocket };
