const jwt = require("jsonwebtoken");
const cookie = require("cookie");
const { jwtSecret } = require("../configs/variables");

const socketAuthMiddleware = async (socket, next) => {
  // Socket.IO's handshake isn't run through Express's cookie-parser, so the
  // httpOnly auth_token cookie (set on login) has to be parsed manually here
  // to let cookie-only clients (no token in query/localStorage) authenticate.
  const cookies = socket.handshake.headers.cookie
    ? cookie.parse(socket.handshake.headers.cookie)
    : {};
  const phoneNumber =
    socket.handshake.query.phone || socket.handshake.headers.phone;
  // A `phone` query param only ever comes from the Customer Panel's socket
  // client. If a staff member (manager/admin) also has an open session in
  // the same browser, the browser will still attach a staff auth cookie to
  // this handshake (shared parent domain) — without this guard, that stray
  // staff cookie would win below and silently re-authenticate the customer's
  // socket as the staff member, so the real customer never gets registered
  // and no call ever reaches a manager.
  // Manager and admin sessions use distinct cookie names
  // ('manager_auth_token' / 'admin_auth_token') so the two don't collide with
  // each other either — this handshake doesn't know in advance which kind of
  // staff session (if any) is connecting, so both are checked.
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers.token ||
    socket.handshake.query.token ||
    socket.handshake.headers.authorization?.split(" ")[1] ||
    (phoneNumber
      ? cookies.customer_auth_token
      : cookies.manager_auth_token || cookies.admin_auth_token || cookies.customer_auth_token);

  if (token) {
    try {
      const decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });

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
        // For a verified customer token, the phone comes from the signed JWT
        // (proof of OTP ownership) rather than the client-supplied query param.
        phone: role === 'customer' ? decoded.phone : (phoneNumber || decoded.phone || decoded.email),
        isAuthenticated: true,
        adminRole: decoded.role, // Original admin role (super_admin, supervisor, admin)
        isAdmin: decoded.type === 'admin',
        ...(decoded.name && { name: decoded.name }),
        ...(decoded.image && { image: decoded.image }),
      };
      console.log(`🔑 Socket auth success: ${decoded.email || decoded.phone} | Role: ${role} | Admin: ${decoded.type === 'admin'}`);
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
