/**
 * Customer session manager — Redis-backed, revocable sessions for OTP-verified
 * customers (parity with the staff sessionManager).
 *
 * A customer JWT alone was stateless: valid until expiry, never revocable. This
 * binds each customer JWT to a server-side session identified by `sid`, carrying
 * a `jti`. Auth (HTTP + socket) validates the session exists and the token's
 * `jti` matches, so a session can be revoked (logout / new-login) and a stale or
 * forged token stops working immediately.
 *
 * The manager is created via a factory that takes the Redis client, so it can be
 * unit-tested with an in-memory stand-in (see customerSession.test.js).
 */
const crypto = require('crypto');

const SESSION_PREFIX = 'customer:session:';
const PHONE_INDEX_PREFIX = 'customer:session:phone:';
const DEFAULT_TTL_SECONDS = 30 * 60; // matches the customer JWT lifetime

// Canonicalize the identity used for the phone index so the key is
// format-independent: a phone/email verified as one format and revoked by
// another equivalent format (e.g. the room_finished webhook using the
// room-name phone) still resolves to the same session. Emails → lowercased;
// phones → digits with the BD country code dropped and a single leading 0.
const normalizeIndexKey = (value) => {
  const s = String(value || '').trim().toLowerCase();
  if (s.includes('@')) return s;
  let c = s.replace(/\D/g, '');
  if (c.startsWith('880') && c.length > 10) c = c.substring(3);
  if (c.startsWith('1') && c.length === 10) c = '0' + c;
  return c;
};

const createCustomerSessionManager = (redis, ttlSeconds = DEFAULT_TTL_SECONDS) => {
  const sessionKey = (sid) => `${SESSION_PREFIX}${sid}`;
  const phoneKey = (phone) => `${PHONE_INDEX_PREFIX}${normalizeIndexKey(phone)}`;

  const revoke = async (sid) => {
    if (!sid) return false;
    const raw = await redis.get(sessionKey(sid));
    if (!raw) return false;
    let phone = null;
    try { phone = JSON.parse(raw).phone; } catch { /* ignore malformed */ }
    await redis.del(sessionKey(sid));
    if (phone) await redis.del(phoneKey(phone));
    return true;
  };

  const revokeByPhone = async (phone) => {
    if (!phone) return false;
    const oldSid = await redis.get(phoneKey(phone));
    if (!oldSid) return false;
    await redis.del(sessionKey(oldSid));
    await redis.del(phoneKey(phone));
    return true;
  };

  const issue = async (phone) => {
    // Single active session per phone: a new OTP login revokes the previous
    // session so the old JWT stops working immediately (real revocation).
    await revokeByPhone(phone);
    const sid = crypto.randomUUID();
    const jti = crypto.randomUUID();
    const session = { sid, phone, jti, createdAt: Date.now() };
    await redis.setex(sessionKey(sid), ttlSeconds, JSON.stringify(session));
    await redis.setex(phoneKey(phone), ttlSeconds, sid);
    return { sid, jti };
  };

  const validate = async (sid, jti) => {
    if (!sid || !jti) return null;
    const raw = await redis.get(sessionKey(sid));
    if (!raw) return null;
    let session;
    try { session = JSON.parse(raw); } catch { return null; }
    if (session.jti !== jti) return null;
    return { phone: session.phone, sid };
  };

  return { issue, validate, revoke, revokeByPhone };
};

// Lazily-built default instance bound to the shared Redis client. Lazy so that
// simply requiring this module (e.g. in unit tests using the factory) does not
// open a Redis connection.
let _default = null;
const getCustomerSessions = () => {
  if (!_default) {
    const { redisClient } = require('../configs/redis');
    _default = createCustomerSessionManager(redisClient);
  }
  return _default;
};

module.exports = { createCustomerSessionManager, getCustomerSessions };
