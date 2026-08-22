const { test } = require('node:test');
const assert = require('node:assert');
const { createVerificationGrants, PURPOSES } = require('./verificationGrant');

function fakeCache() {
  const m = new Map();
  return {
    store: m,
    async set(k, v) { m.set(k, v); },
    async get(k) { return m.has(k) ? m.get(k) : undefined; },
    async del(k) { m.delete(k); },
  };
}

test('grant then consume → true, and the grant is single-use (second consume false)', async () => {
  const g = createVerificationGrants(fakeCache());
  await g.grant(PURPOSES.CHANGE_PHONE, '01711111111');
  assert.strictEqual(await g.consume(PURPOSES.CHANGE_PHONE, '01711111111'), true);
  assert.strictEqual(await g.consume(PURPOSES.CHANGE_PHONE, '01711111111'), false);
});

test('consume with no prior grant → false (change blocked)', async () => {
  const g = createVerificationGrants(fakeCache());
  assert.strictEqual(await g.consume(PURPOSES.CHANGE_PHONE, '01711111111'), false);
});

test('grant is purpose-isolated (CHANGE_PHONE grant does not satisfy CHANGE_EMAIL)', async () => {
  const g = createVerificationGrants(fakeCache());
  await g.grant(PURPOSES.CHANGE_PHONE, '01711111111');
  assert.strictEqual(await g.consume(PURPOSES.CHANGE_EMAIL, '01711111111'), false);
});

test('grant is value-bound (a grant for X does not satisfy a change to Y)', async () => {
  const g = createVerificationGrants(fakeCache());
  await g.grant(PURPOSES.CHANGE_PHONE, '01711111111');
  assert.strictEqual(await g.consume(PURPOSES.CHANGE_PHONE, '01722222222'), false);
});

test('phone value matches across BD country-code formatting', async () => {
  const g = createVerificationGrants(fakeCache());
  await g.grant(PURPOSES.CHANGE_PHONE, '+8801711111111');
  assert.strictEqual(await g.consume(PURPOSES.CHANGE_PHONE, '01711111111'), true);
});

test('email value matches case-insensitively', async () => {
  const g = createVerificationGrants(fakeCache());
  await g.grant(PURPOSES.CHANGE_EMAIL, 'A@Example.com');
  assert.strictEqual(await g.consume(PURPOSES.CHANGE_EMAIL, 'a@example.com'), true);
});

test('grant() rejects an unknown purpose', async () => {
  const g = createVerificationGrants(fakeCache());
  await assert.rejects(() => g.grant('NOT_A_PURPOSE', '01711111111'));
});

test('isValidPurpose gates unknown purposes', () => {
  const g = createVerificationGrants(fakeCache());
  assert.strictEqual(g.isValidPurpose(PURPOSES.CHANGE_ADDRESS), true);
  assert.strictEqual(g.isValidPurpose('FOO'), false);
});
