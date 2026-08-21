const { test } = require('node:test');
const assert = require('node:assert');
const { createOtpChallengeManager, normalizeTarget } = require('./otpChallenge');

// Minimal Map-backed cache with the same (set/get/del) surface as otpCache.
function fakeCache() {
  const m = new Map();
  return {
    store: m,
    async set(k, v) { m.set(k, v); },
    async get(k) { return m.has(k) ? m.get(k) : undefined; },
    async del(k) { m.delete(k); },
  };
}

let seq = 0;
const deps = () => ({ genId: () => `chal-${++seq}` });

test('issue() returns an id and stores a record bound to the normalized target', async () => {
  const cache = fakeCache();
  const mgr = createOtpChallengeManager(cache, deps());
  const id = await mgr.issue('phone', '01711111111');
  assert.ok(id, 'returns a challenge id');
  const rec = await mgr.resolve(id, 'phone', '01711111111');
  assert.strictEqual(rec.target, '01711111111');
  assert.strictEqual(rec.type, 'phone');
});

test('resolve() returns null for an unknown / never-issued challenge id', async () => {
  const cache = fakeCache();
  const mgr = createOtpChallengeManager(cache, deps());
  assert.strictEqual(await mgr.resolve('does-not-exist', 'phone', '01711111111'), null);
});

test('resolve() returns null when the claimed target differs from the bound target', async () => {
  const cache = fakeCache();
  const mgr = createOtpChallengeManager(cache, deps());
  const id = await mgr.issue('phone', '01711111111');
  // A challenge issued for A must not authorize verification of B.
  assert.strictEqual(await mgr.resolve(id, 'phone', '01722222222'), null);
});

test('resolve() returns null when the type differs (phone challenge, email claim)', async () => {
  const cache = fakeCache();
  const mgr = createOtpChallengeManager(cache, deps());
  const id = await mgr.issue('phone', '01711111111');
  assert.strictEqual(await mgr.resolve(id, 'email', '01711111111'), null);
});

test('resolve() matches despite phone formatting differences (BD country code)', async () => {
  const cache = fakeCache();
  const mgr = createOtpChallengeManager(cache, deps());
  const id = await mgr.issue('phone', '01711111111');
  const rec = await mgr.resolve(id, 'phone', '+8801711111111');
  assert.ok(rec, 'normalized match across +880 prefix');
});

test('consume() deletes the challenge so it cannot be replayed', async () => {
  const cache = fakeCache();
  const mgr = createOtpChallengeManager(cache, deps());
  const id = await mgr.issue('email', 'A@Example.com');
  assert.ok(await mgr.resolve(id, 'email', 'a@example.com'));
  await mgr.consume(id);
  assert.strictEqual(await mgr.resolve(id, 'email', 'a@example.com'), null);
});

test('normalizeTarget lowercases/trims email and canonicalizes phone', () => {
  assert.strictEqual(normalizeTarget('email', '  A@Example.com '), 'a@example.com');
  assert.strictEqual(normalizeTarget('phone', '+8801711111111'), '01711111111');
});
