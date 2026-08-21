const { test } = require('node:test');
const assert = require('node:assert');
const { redactAccountsForCaller } = require('./accountRedaction');

const norm = (x) => String(x || '').replace(/\D/g, '');

test('owner querying their own number → full account data', () => {
  const accounts = [{ accountNumber: '1', balance: 500 }];
  assert.deepStrictEqual(redactAccountsForCaller(accounts, '01711111111', '01711111111', norm), accounts);
});

test('staff caller (no callerPhone) → full account data', () => {
  const accounts = [{ accountNumber: '1' }];
  assert.deepStrictEqual(redactAccountsForCaller(accounts, null, '01711111111', norm), accounts);
});

test('customer querying ANOTHER number with accounts → boolean true (no details)', () => {
  const r = redactAccountsForCaller([{ accountNumber: '1' }], '01711111111', '01722222222', norm);
  assert.strictEqual(r, true);
});

test('customer querying ANOTHER number with no accounts → boolean false', () => {
  const r = redactAccountsForCaller([], '01711111111', '01722222222', norm);
  assert.strictEqual(r, false);
});

test('never leaks the account array to a cross-number customer', () => {
  const r = redactAccountsForCaller([{ accountNumber: 'SECRET' }], '017', '018', norm);
  assert.notStrictEqual(typeof r, 'object');
  assert.strictEqual(r, true);
});
