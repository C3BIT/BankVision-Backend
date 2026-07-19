// Redis-backed replacement for the old per-process node-cache instance.
// OTP state (codes, attempt counters, lockouts) must be visible to every
// core-api replica — a customer whose send-OTP request lands on Pod A and
// verify-OTP lands on Pod B would otherwise always fail verification.
const { redisClient } = require("../configs/redis");

const KEY_PREFIX = "otp:";

const otpCache = {
  get: async (key) => {
    const raw = await redisClient.get(KEY_PREFIX + key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  },
  // ttlSeconds mirrors the node-cache `.set(key, value, ttl)` signature every
  // call site already uses — always pass it explicitly (no default TTL).
  set: async (key, value, ttlSeconds) => {
    await redisClient.set(KEY_PREFIX + key, JSON.stringify(value), "EX", ttlSeconds);
  },
  del: async (key) => {
    await redisClient.del(KEY_PREFIX + key);
  },
};

module.exports = { otpCache };
