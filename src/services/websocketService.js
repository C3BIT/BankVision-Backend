const socketIo = require("socket.io");
const { handleSocketConnection } = require("./socketHandler");
const { socketAuthMiddleware } = require("../middlewares/socketAuth");

const initializeWebSocket = (server) => {
  const io = socketIo(server, {
    cors: {
      origin: "*",
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
