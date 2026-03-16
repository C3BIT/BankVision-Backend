const socketIo = require("socket.io");
const { handleSocketConnection } = require("./socketHandler");
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
  io.use(socketAuthMiddleware);

  io.on("connection", (socket) => {
    handleSocketConnection(socket, io);
  });
  return io;
};

module.exports = { initializeWebSocket };
