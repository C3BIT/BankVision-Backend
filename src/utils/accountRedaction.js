/**
 * Explicit authorization model for account lookups (replaces "look up, then
 * throw the data away" response-redaction).
 *
 * - Owner querying their own number, or staff (no caller identity): full data.
 * - A customer querying ANOTHER number: existence boolean only — no account
 *   numbers, balances or any field (prevents PII / account enumeration).
 */
function redactAccountsForCaller(accounts, callerPhone, queriedPhone, normalize = (x) => x) {
  const list = Array.isArray(accounts) ? accounts : [];
  // Staff (no customer identity) or the owner querying their own number.
  if (!callerPhone || normalize(callerPhone) === normalize(queriedPhone)) return list;
  // Customer querying a different number → existence only.
  return list.length > 0;
}

module.exports = { redactAccountsForCaller };
