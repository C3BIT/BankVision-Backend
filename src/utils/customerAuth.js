/**
 * Centralized customer authentication — one implementation used by BOTH the
 * Express middleware and the Socket.IO handshake, so the two cannot drift.
 *
 * Verifies the signed JWT AND the Redis-backed session (existence + jti match),
 * so a customer session is revocable and a stale/forged token is rejected.
 *
 * Dependency-injected (`verify`, `sessions`) for unit testing; defaults bind to
 * the real jsonwebtoken + jwtSecret + the shared customer session manager.
 */
const authErr = (code) => Object.assign(new Error(code), { code });

async function authenticateCustomerToken(token, deps = {}) {
  const verify = deps.verify || (() => {
    const jwt = require('jsonwebtoken');
    const { jwtSecret } = require('../configs/variables');
    return jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
  });
  const sessions = deps.sessions || require('./customerSession').getCustomerSessions();

  if (!token) throw authErr('NO_TOKEN');

  let decoded;
  try {
    decoded = verify(token);
  } catch (err) {
    throw Object.assign(authErr('INVALID'), { cause: err });
  }

  if (decoded.role !== 'customer' || !decoded.phone) throw authErr('ROLE');
  if (!decoded.sid || !decoded.jti) throw authErr('NO_SESSION_CLAIMS'); // legacy stateless token

  const session = await sessions.validate(decoded.sid, decoded.jti);
  if (!session) throw authErr('NO_SESSION'); // revoked / expired / rotated

  return { phone: decoded.phone, sid: decoded.sid, jti: decoded.jti, decoded };
}

module.exports = { authenticateCustomerToken };
