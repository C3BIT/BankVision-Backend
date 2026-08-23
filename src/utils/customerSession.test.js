const { test } = require('node:test');
const assert = require('node:assert');
const { createCustomerSessionManager } = require('./customerSession');

// Minimal in-memory stand-in for the ioredis client (only the calls we use).
function fakeRedis() {
  const m = new Map();
  return {
    _map: m,
    async setex(k, _ttl, v) { m.set(k, v); },
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async del(k) { const had = m.has(k); m.delete(k); return had ? 1 : 0; },
  };
}

test('issue() returns a sid + jti and stores a validatable session', async () => {
  const mgr = createCustomerSessionManager(fakeRedis());
  const { sid, jti } = await mgr.issue('01711111111');
  assert.ok(sid, 'sid present');
  assert.ok(jti, 'jti present');
  const session = await mgr.validate(sid, jti);
  assert.ok(session, 'session validates');
  assert.strictEqual(session.phone, '01711111111');
});

test('validate() returns null for an unknown/never-issued session', async () => {
  const mgr = createCustomerSessionManager(fakeRedis());
  assert.strictEqual(await mgr.validate('nope', 'nope'), null);
});

test('validate() returns null when the jti does not match (stale/forged token)', async () => {
  const mgr = createCustomerSessionManager(fakeRedis());
  const { sid } = await mgr.issue('01711111111');
  assert.strictEqual(await mgr.validate(sid, 'WRONG-JTI'), null);
});

test('revoke() invalidates the session', async () => {
  const mgr = createCustomerSessionManager(fakeRedis());
  const { sid, jti } = await mgr.issue('01711111111');
  await mgr.revoke(sid);
  assert.strictEqual(await mgr.validate(sid, jti), null);
});

test('issuing a new session for a phone revokes the previous one (single active session)', async () => {
  const mgr = createCustomerSessionManager(fakeRedis());
  const first = await mgr.issue('01711111111');
  const second = await mgr.issue('01711111111');
  assert.strictEqual(await mgr.validate(first.sid, first.jti), null, 'old session revoked');
  assert.ok(await mgr.validate(second.sid, second.jti), 'new session valid');
});

test('two different phones keep independent sessions', async () => {
  const mgr = createCustomerSessionManager(fakeRedis());
  const a = await mgr.issue('01711111111');
  const b = await mgr.issue('01722222222');
  assert.ok(await mgr.validate(a.sid, a.jti), 'phone A still valid');
  assert.ok(await mgr.validate(b.sid, b.jti), 'phone B valid');
});

test('revokeByPhone matches regardless of phone format (normalized key)', async () => {
  const mgr = createCustomerSessionManager(fakeRedis());
  const { sid, jti } = await mgr.issue('+8801711111111');
  // The room_finished webhook revokes by the room-name phone, which may be a
  // differently-formatted-but-equivalent number — it must still match.
  assert.strictEqual(await mgr.revokeByPhone('01711111111'), true);
  assert.strictEqual(await mgr.validate(sid, jti), null, 'session revoked');
});
