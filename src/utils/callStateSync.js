// Cross-pod replication for activeCustomerCalls / activeSupervisors.
//
// These two maps were purely per-process in-memory state. With multiple
// core-api replicas and no session affinity, a request or socket event
// touching a given call could land on any pod, so:
//   - Reads on a pod that never handled this call's create saw nothing
//     (partially patched by the pull-on-miss RPC below).
//   - Field mutations made on the *owning* pod (faceVerified, status,
//     currentManagerEmail, ...) never reached a pod that had earlier cloned
//     the same call via that pull, so the clone silently went stale.
//   - activeSupervisors had no cross-pod handling at all.
//
// This follows presenceSync.js's proven pattern: a Redis hash is the durable
// source of truth (hydrate a freshly-started pod from it) and a pub/sub
// channel fans out every mutation so all pods converge within one Redis
// round-trip, keeping every pod's local object the fast synchronous read
// path (zero call-site changes for reads).
//
// Two fields on activeCustomerCalls entries can't be replicated as-is:
//   - `timeout` / `faceVerificationTimeout` are Node Timer handles, only
//     meaningful on the pod that owns the running timer.
//   - `attemptedManagers` is a Set, which JSON can't carry directly.
// Both are stripped before publish and reconstructed (or nulled) on receipt,
// same as the pre-existing getActiveCallLocalRaw()/ensureLocalActiveCall()
// cross-pod snapshot already did for the pull-based RPC path.
//
// A publish is applied to Redis + broadcast, but NOT re-applied to this same
// pod's local object when its own echo comes back over the subscription —
// the local object was already updated in place by the caller (and still
// holds its live `timeout` handle, if any) before publish*() was called.
// Re-applying the stripped snapshot on self-receipt would null out that
// live timer reference and break its cancellation path. An `origin` tag
// (unique per process) on every published message is how each pod tells its
// own echo apart from a genuinely remote update.

const crypto = require("crypto");
const Redis = require("ioredis");

const redisOpts = {
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

const POD_ID = crypto.randomUUID();

const CALLS_HASH = "activecalls:customers";
const CALLS_CHANNEL = "activecalls:events";
const SUPERVISORS_HASH = "activecalls:supervisors";
const SUPERVISORS_CHANNEL = "activesupervisors:events";

const pubClient = new Redis(redisOpts);
const subClient = new Redis(redisOpts);

pubClient.on("error", (err) => console.error("⚠️ callStateSync pubClient Redis error:", err.message));
subClient.on("error", (err) => console.error("⚠️ callStateSync subClient Redis error:", err.message));

let subscribed = false;

// Injected by index.js at bootstrap (avoids a require cycle with socketHandler.js).
let activeCustomerCalls = null;
let activeSupervisors = null;

const registerStores = (customerCallsStore, supervisorsStore) => {
  activeCustomerCalls = customerCallsStore;
  activeSupervisors = supervisorsStore;
};

const stripCallForWire = (call) => {
  const { timeout, faceVerificationTimeout, attemptedManagers, broadcastedManagers, ...safe } = call;
  return {
    ...safe,
    attemptedManagers: attemptedManagers ? Array.from(attemptedManagers) : [],
    broadcastedManagers: broadcastedManagers ? Array.from(broadcastedManagers) : [],
  };
};

const applyRemoteCallSet = (phone, value) => {
  if (!activeCustomerCalls) return;
  activeCustomerCalls[phone] = {
    ...value,
    timeout: null,
    faceVerificationTimeout: null,
    attemptedManagers: new Set(value.attemptedManagers || []),
    broadcastedManagers: new Set(value.broadcastedManagers || []),
  };
};

const applyRemoteCallDel = (phone) => {
  if (!activeCustomerCalls) return;
  delete activeCustomerCalls[phone];
};

const applyRemoteSupervisorSet = (socketId, value) => {
  if (!activeSupervisors) return;
  activeSupervisors[socketId] = value;
};

const applyRemoteSupervisorDel = (socketId) => {
  if (!activeSupervisors) return;
  delete activeSupervisors[socketId];
};

// Called once at server bootstrap, before the HTTP server starts accepting
// traffic, so this pod's local maps reflect calls/supervisors already active
// on other pods.
const initCallStateSync = async (customerCallsStore, supervisorsStore) => {
  registerStores(customerCallsStore, supervisorsStore);

  try {
    const [calls, supervisors] = await Promise.all([
      pubClient.hgetall(CALLS_HASH),
      pubClient.hgetall(SUPERVISORS_HASH),
    ]);

    for (const [phone, raw] of Object.entries(calls)) {
      try {
        applyRemoteCallSet(phone, JSON.parse(raw));
      } catch {
        // skip malformed entry rather than fail the whole hydrate
      }
    }
    for (const [socketId, raw] of Object.entries(supervisors)) {
      try {
        applyRemoteSupervisorSet(socketId, JSON.parse(raw));
      } catch {
        // skip malformed entry rather than fail the whole hydrate
      }
    }

    console.log(
      `♻️ callStateSync: hydrated ${Object.keys(calls).length} active call(s), ` +
      `${Object.keys(supervisors).length} supervisor(s) from Redis`
    );
  } catch (error) {
    console.error("⚠️ callStateSync: failed to hydrate from Redis:", error.message);
  }

  if (!subscribed) {
    subscribed = true;
    await subClient.subscribe(CALLS_CHANNEL, SUPERVISORS_CHANNEL);
    subClient.on("message", (channel, message) => {
      let parsed;
      try {
        parsed = JSON.parse(message);
      } catch (error) {
        console.error(`⚠️ callStateSync: failed to parse message on ${channel}:`, error.message);
        return;
      }
      const { op, key, value, origin } = parsed;
      if (origin === POD_ID) return; // this pod already applied it synchronously at publish time

      if (channel === CALLS_CHANNEL) {
        if (op === "set") applyRemoteCallSet(key, value);
        else if (op === "del") applyRemoteCallDel(key);
      } else if (channel === SUPERVISORS_CHANNEL) {
        if (op === "set") applyRemoteSupervisorSet(key, value);
        else if (op === "del") applyRemoteSupervisorDel(key);
      }
    });
  }
};

// Replicates the current state of activeCustomerCalls[phone] (already
// mutated in place by the caller) to Redis + every other pod. Call this
// after every create/mutate of an entry.
const publishCallSet = (phone, call) => {
  const payload = stripCallForWire(call);
  pubClient.hset(CALLS_HASH, phone, JSON.stringify(payload)).catch((err) =>
    console.error(`⚠️ callStateSync: failed to persist call ${phone} to Redis:`, err.message)
  );
  pubClient.publish(CALLS_CHANNEL, JSON.stringify({ op: "set", key: phone, value: payload, origin: POD_ID })).catch((err) =>
    console.error(`⚠️ callStateSync: failed to publish call set for ${phone}:`, err.message)
  );
};

const publishCallDelete = (phone) => {
  pubClient.hdel(CALLS_HASH, phone).catch((err) =>
    console.error(`⚠️ callStateSync: failed to delete call ${phone} from Redis:`, err.message)
  );
  pubClient.publish(CALLS_CHANNEL, JSON.stringify({ op: "del", key: phone, origin: POD_ID })).catch((err) =>
    console.error(`⚠️ callStateSync: failed to publish call del for ${phone}:`, err.message)
  );
};

// Direct Redis read fallback for the rare race where a pod needs a call
// that was just created/updated on another pod but whose pub/sub message
// hasn't arrived yet. Cheap single GET, used only on local-miss.
const fetchCallFromRedis = async (phone) => {
  try {
    const raw = await pubClient.hget(CALLS_HASH, phone);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error(`⚠️ callStateSync: Redis fetch failed for ${phone}:`, error.message);
    return null;
  }
};

const publishSupervisorSet = (socketId, value) => {
  pubClient.hset(SUPERVISORS_HASH, socketId, JSON.stringify(value)).catch((err) =>
    console.error(`⚠️ callStateSync: failed to persist supervisor ${socketId} to Redis:`, err.message)
  );
  pubClient.publish(SUPERVISORS_CHANNEL, JSON.stringify({ op: "set", key: socketId, value, origin: POD_ID })).catch((err) =>
    console.error(`⚠️ callStateSync: failed to publish supervisor set for ${socketId}:`, err.message)
  );
};

const publishSupervisorDelete = (socketId) => {
  pubClient.hdel(SUPERVISORS_HASH, socketId).catch((err) =>
    console.error(`⚠️ callStateSync: failed to delete supervisor ${socketId} from Redis:`, err.message)
  );
  pubClient.publish(SUPERVISORS_CHANNEL, JSON.stringify({ op: "del", key: socketId, origin: POD_ID })).catch((err) =>
    console.error(`⚠️ callStateSync: failed to publish supervisor del for ${socketId}:`, err.message)
  );
};

module.exports = {
  initCallStateSync,
  publishCallSet,
  publishCallDelete,
  fetchCallFromRedis,
  publishSupervisorSet,
  publishSupervisorDelete,
};
