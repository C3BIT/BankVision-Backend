const { test } = require('node:test');
const assert = require('node:assert');
const { authenticateCustomerToken } = require('./customerAuth');

const okSessions = { async validate(sid) { return { phone: '01711111111', sid }; } };
const noSessions = { async validate() { return null; } };
const goodClaims = { role: 'customer', phone: '01711111111', sid: 'S1', jti: 'J1', exp: 9999999999 };

test('valid token + valid session → returns phone + sid', async () => {
  const r = await authenticateCustomerToken('tok', { verify: () => ({ ...goodClaims }), sessions: okSessions });
  assert.strictEqual(r.phone, '01711111111');
  assert.strictEqual(r.sid, 'S1');
});

test('missing token → rejects', async () => {
  await assert.rejects(() => authenticateCustomerToken('', { verify: () => ({}), sessions: okSessions }));
});

test('invalid signature → rejects', async () => {
  const verify = () => { throw new Error('bad sig'); };
  await assert.rejects(() => authenticateCustomerToken('tok', { verify, sessions: okSessions }));
});

test('wrong role → rejects', async () => {
  const verify = () => ({ ...goodClaims, role: 'manager' });
  await assert.rejects(() => authenticateCustomerToken('tok', { verify, sessions: okSessions }));
});

test('legacy stateless token without sid/jti → rejects', async () => {
  const verify = () => ({ role: 'customer', phone: '01711111111' });
  await assert.rejects(() => authenticateCustomerToken('tok', { verify, sessions: okSessions }));
});

test('valid JWT but session revoked/absent → rejects with NO_SESSION', async () => {
  await assert.rejects(
    () => authenticateCustomerToken('tok', { verify: () => ({ ...goodClaims }), sessions: noSessions }),
    (err) => err.code === 'NO_SESSION'
  );
});
