const crypto = require("crypto");

// Purpose-bound, single-use verification grant (Rizwan review, Phase 3 / #10).
//
// A grant is server-side proof that an OTP was successfully verified FOR A
// SPECIFIC SENSITIVE OPERATION and value — e.g. "the new phone 0171... was
// OTP-verified for CHANGE_PHONE". Sensitive change handlers must consume a
// matching grant before writing to CBS, so an attacker who fakes the OTP
// response (or emits the approve socket event directly) still can't complete
// the change: no grant was ever created server-side.
//
// Separation of concerns (Rizwan #10): a plain customer session means
// "authenticated as this phone"; a grant means "just proved control of THIS
// value for THIS purpose". The two are deliberately distinct.

const PURPOSES = Object.freeze({
  CHANGE_PHONE: "CHANGE_PHONE",
  CHANGE_EMAIL: "CHANGE_EMAIL",
  CHANGE_ADDRESS: "CHANGE_ADDRESS",
});
const VALID = new Set(Object.values(PURPOSES));

const GRANT_TTL = 300; // seconds — short window between OTP verify and approval
const GRANT_PREFIX = "vgrant:";

// Normalize the bound value identically at grant time and consume time so
// formatting differences (phone +880 vs local, email case) never break a match.
const normalizeValue = (value) => {
  const v = String(value || "");
  if (v.includes("@")) return v.toLowerCase().trim();
  let c = v.replace(/\D/g, "");
  if (c.startsWith("880") && c.length > 10) c = c.substring(3);
  if (c.startsWith("1") && c.length === 10) c = "0" + c;
  return c;
};

function createVerificationGrants(cache, deps = {}) {
  const ttl = deps.ttl || GRANT_TTL;
  const isValidPurpose = (purpose) => VALID.has(purpose);
  const key = (purpose, value) =>
    `${GRANT_PREFIX}${purpose}:${normalizeValue(value)}`;

  const grant = async (purpose, value) => {
    if (!isValidPurpose(purpose)) {
      throw new Error(`Unknown verification purpose: ${purpose}`);
    }
    // A random token as the value keeps the record non-forgeable and lets us
    // treat presence as proof; the key itself carries the (purpose, value) bind.
    await cache.set(key(purpose, value), crypto.randomUUID(), ttl);
  };

  // Single-use: returns true and deletes the grant on a match, false otherwise.
  const consume = async (purpose, value) => {
    if (!isValidPurpose(purpose)) return false;
    const k = key(purpose, value);
    const proof = await cache.get(k);
    if (!proof) return false;
    await cache.del(k);
    return true;
  };

  return { grant, consume, isValidPurpose };
}

// Lazily bound to the shared otpCache (Redis) for production use.
let _grants = null;
const getVerificationGrants = () => {
  if (!_grants) {
    const { otpCache } = require("./otpCache");
    _grants = createVerificationGrants(otpCache);
  }
  return _grants;
};

module.exports = { createVerificationGrants, getVerificationGrants, PURPOSES };
