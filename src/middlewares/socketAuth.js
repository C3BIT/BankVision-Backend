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

      // Customers go through the SAME implementation as the HTTP middleware
      // (authenticateCustomerToken) so the two can never drift: it re-verifies
      // the signed JWT AND the revocable Redis session, rejecting legacy
      // stateless tokens (no sid/jti) and revoked/expired sessions.
      if (role === 'customer') {
        const { authenticateCustomerToken } = require('../utils/customerAuth');
        try {
          await authenticateCustomerToken(token);
        } catch (err) {
          console.log('🚨 Socket auth rejected — customer session invalid:', err.code || err.message);
          return next(new Error("Authentication failed: session expired or invalid. Please verify again."));
        }
      } else {
        // Staff (manager / admin / supervisor): enforce the SAME revocable
        // Redis session the HTTP middleware requires
        // (authMiddleware / adminAuthMiddleware), so a logged-out, superseded
        // (logged in elsewhere) or force-revoked staff JWT can't still open a
        // socket and drive calls (initiate-call, capture, face-verify) until
        // it naturally expires. Without this the socket trusted a bare
        // signature while every REST call already required the live session —
        // exactly the customer/staff parity gap flagged in review.
        const { getSession } = require('../utils/sessionManager');
        const session = await getSession(decoded.id);
        if (!session || session.token !== token) {
          console.log('🚨 Socket auth rejected — staff session revoked/superseded:', decoded.email || decoded.id);
          return next(new Error("Authentication failed: session expired or logged in elsewhere. Please log in again."));
        }
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
      // An invalid/expired token is never silently downgraded to an anonymous
      // customer session. Previously, a client that supplied a `phone` query
      // param with an expired (or absent) token was admitted as
      // { isAuthenticated: false }; since no downstream handler ever read that
      // flag, the entire queue/call/face-capture flow ran with no proof of OTP
      // ownership — the "response manipulation" bypass (pentest Critical
      // finding #1). The customer must re-verify to obtain a fresh signed token.
      console.log("🚨 Socket auth rejected — token expired or invalid:", error.message);
      return next(
        new Error("Authentication failed: session expired or invalid. Please verify again.")
      );
    }
  } else {
    // No token at all. A bare `phone` query param used to be sufficient to join
    // as an anonymous customer — that was the bypass. A verified OTP session
    // (customer_auth_token) or a staff session cookie is now mandatory.
    return next(
      new Error("Authentication error: verification required")
    );
  }
};

module.exports = { socketAuthMiddleware };
