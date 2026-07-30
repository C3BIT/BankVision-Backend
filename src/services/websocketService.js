const socketIo = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const Redis = require("ioredis");
const { handleSocketConnection, getActiveCallsData, getActiveCallLocalRaw, cancelDisconnectTimerLocal, handleManagerReconnectLocal, clearActiveCustomerCallLocal } = require("./socketHandler");
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
    // Keepalive tuned for the proxy in front of the pods: the manager socket was
    // being dropped at ~20s idle, before Socket.IO's default 25s ping could send
    // a frame — so the connection died and reconnected in a loop, and the call-
    // routing worker kept finding the manager mid-reconnect (missed calls). Ping
    // every 10s keeps a frame flowing well inside the idle window.
    pingInterval: 10000,
    pingTimeout: 20000,
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

  // Answers cross-pod requests (see reconnect handling in socketHandler.js)
  // to cancel a disconnect grace-timer this pod is holding, triggered by a
  // reconnect that landed on a different pod.
  io.on("cancel-disconnect-timer-local", (timerKey, callback) => {
    callback(cancelDisconnectTimerLocal(timerKey));
  });

  // Answers cross-pod requests for a reconnecting manager whose active call
  // (and grace timer) live on a different pod than the one that received
  // their new socket connection.
  io.on("manager-reconnect-local", ({ email, newSocketId }, callback) => {
    callback(handleManagerReconnectLocal(io, email, newSocketId));
  });

  // A call teardown (clearActiveCustomerCall) only runs fully on the pod that
  // handled it — this cleans up any cross-pod clone (see ensureLocalActiveCall)
  // left behind on other pods so a stale entry can't be matched against a
  // manager's later reconnect or new call.
  io.on("clear-active-call-local", (normalizedPhone) => {
    clearActiveCustomerCallLocal(normalizedPhone);
  });

  io.on("connection", (socket) => {
    handleSocketConnection(socket, io);
  });
  return io;
};

module.exports = { initializeWebSocket };
