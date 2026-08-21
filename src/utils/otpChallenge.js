const crypto = require("crypto");

// OTP challenge binding (Phase 2).
//
// Previously an OTP was addressable purely by its target (phone/email): anyone
// who knew a victim's number could aim verification attempts at that number's
// OTP slot. A challenge binds each send to an unguessable, server-issued id.
// Verification must present that id AND it must resolve to the same target the
// caller claims — so the OTP slot can only be addressed by the party that
// initiated the send (and holds the returned challengeId), not by anyone who
// merely knows the phone number.
//
// The OTP *value* itself continues to live in the target-keyed slot managed by
// otpService (so lockout / attempt counting / master-bypass are unchanged and
// reused); this layer only adds the id→target binding on top.

const CHALLENGE_TTL = 180; // seconds — matches OTP_EXPIRY_TIME
const CHALLENGE_PREFIX = "otpchal:";

// Same canonicalization the rest of the OTP layer uses so a challenge issued
// from one phone format resolves against another (e.g. +880 vs local 0-prefixed).
const normalizeTarget = (type, value) => {
  if (type === "phone") {
    let c = String(value || "").replace(/\D/g, "");
    if (c.startsWith("880") && c.length > 10) c = c.substring(3);
    if (c.startsWith("1") && c.length === 10) c = "0" + c;
    return c;
  }
  return String(value || "").toLowerCase().trim();
};

function createOtpChallengeManager(cache, deps = {}) {
  const genId = deps.genId || (() => crypto.randomUUID());
  const ttl = deps.ttl || CHALLENGE_TTL;

  const issue = async (type, target) => {
    const challengeId = genId();
    await cache.set(
      CHALLENGE_PREFIX + challengeId,
      { type, target: normalizeTarget(type, target) },
      ttl
    );
    return challengeId;
  };

  // Authoritative binding check. Returns the stored record only when the
  // challenge exists AND binds to the claimed (type, target); null otherwise.
  // Non-consuming — the caller consumes on a successful OTP match so a failed
  // OTP attempt can be retried against the same challenge (within lockout).
  const resolve = async (challengeId, type, claimedTarget) => {
    if (!challengeId) return null;
    const rec = await cache.get(CHALLENGE_PREFIX + challengeId);
    if (!rec) return null;
    if (rec.type !== type) return null;
    if (rec.target !== normalizeTarget(type, claimedTarget)) return null;
    return rec;
  };

  const consume = async (challengeId) => {
    if (!challengeId) return;
    await cache.del(CHALLENGE_PREFIX + challengeId);
  };

  return { issue, resolve, consume };
}

// Lazily bound to the shared otpCache so unit tests can inject a fake cache
// (and a deterministic id generator) without touching Redis.
let _challenges = null;
const getOtpChallenges = () => {
  if (!_challenges) {
    const { otpCache } = require("./otpCache");
    _challenges = createOtpChallengeManager(otpCache);
  }
  return _challenges;
};

module.exports = { createOtpChallengeManager, normalizeTarget, getOtpChallenges };
