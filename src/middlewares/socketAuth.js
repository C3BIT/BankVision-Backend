const jwt = require("jsonwebtoken");
const { jwtSecret } = require("../configs/variables");

const socketAuthMiddleware = async (socket, next) => {
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers.token ||
    socket.handshake.query.token ||
    socket.handshake.headers.authorization?.split(" ")[1];
  const phoneNumber =
    socket.handshake.query.phone || socket.handshake.headers.phone;

  if (token) {
    try {
      const decoded = jwt.verify(token, jwtSecret);

      // Handle admin/supervisor tokens (they have type: 'admin')
      let role = decoded.role;
      if (decoded.type === 'admin') {
        // For admin tokens, use 'admin' or 'supervisor' based on their role
        role = decoded.role === 'supervisor' ? 'supervisor' : 'admin';
      }

      socket.user = {
        id: decoded.id,
        role: role,
        email: decoded.email,
        isAuthenticated: true,
        adminRole: decoded.role, // Original admin role (super_admin, supervisor, admin)
        isAdmin: decoded.type === 'admin',
        ...(decoded.name && { name: decoded.name }),
        ...(decoded.image && { image: decoded.image }),
      };
      console.log(`🔑 Socket auth success: ${decoded.email} | Role: ${role} | Admin: ${decoded.type === 'admin'}`);
      return next();
    } catch (error) {
      console.log("🚨 Token Expired or Invalid:", error.message);
      socket.tokenExpired = true;
      if (phoneNumber) {
        socket.user = {
          phone: phoneNumber,
          isAuthenticated: false,
          role: "customer",
        };
        return next();
      }
      return next(
        new Error("Authentication failed: Invalid token and no phone provided")
      );
    }
  } else if (phoneNumber) {
    socket.user = {
      phone: phoneNumber,
      isAuthenticated: false,
      role: "customer",
    };
    return next();
  } else {
    return next(
      new Error("Authentication error: No token or phone number provided")
    );
  }
};

module.exports = { socketAuthMiddleware };
