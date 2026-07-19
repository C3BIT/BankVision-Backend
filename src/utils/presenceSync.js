// Cross-pod replication for the manager/customer presence cache.
//
// cacheService.js's userCache (memoryCache.js) is a per-process node-cache
// instance, so with core-api running multiple replicas, a customer socket
// landing on pod A could see zero available managers even though a manager
// is connected to pod B — findAvailableManagers()/getOnlineUsersWithInfo()
// only ever saw pod A's local state.
//
// Rather than converting every synchronous read call site in socketHandler.js
// (60+ of them) to async Redis calls, this module keeps every pod's local
// node-cache authoritative for reads (zero call-site changes) and replicates
// writes across pods:
//   - Every add/remove/status-update is written to a Redis hash (source of
//     truth for a freshly-started pod to hydrate from) AND published on a
//     pub/sub channel.
//   - Every pod (including the one that published) subscribes and applies
//     the same mutation to its local node-cache, so all pods converge within
//     one Redis round-trip (single-digit ms in practice).

const Redis = require("ioredis");
const { userCache } = require("./memoryCache");

const redisOpts = {
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

const HASH_KEY = "presence:users";
const CHANNEL = "presence:events";

const pubClient = new Redis(redisOpts);
const subClient = new Redis(redisOpts);

pubClient.on("error", (err) => console.error("⚠️ presenceSync pubClient Redis error:", err.message));
subClient.on("error", (err) => console.error("⚠️ presenceSync subClient Redis error:", err.message));

let subscribed = false;

const applyLocally = (op, key, value) => {
  if (op === "set") {
    userCache.set(key, value);
  } else if (op === "del") {
    userCache.del(key);
  }
};

// Called once at server bootstrap, before the HTTP server starts accepting
// traffic, so this pod's local cache reflects any users already connected to
// other pods.
const initPresenceSync = async () => {
  try {
    const all = await pubClient.hgetall(HASH_KEY);
    for (const [key, raw] of Object.entries(all)) {
      try {
        applyLocally("set", key, JSON.parse(raw));
      } catch {
        // skip malformed entry rather than fail the whole hydrate
      }
    }
    console.log(`♻️ presenceSync: hydrated ${Object.keys(all).length} cached user(s) from Redis`);
  } catch (error) {
    console.error("⚠️ presenceSync: failed to hydrate from Redis:", error.message);
  }

  if (!subscribed) {
    subscribed = true;
    await subClient.subscribe(CHANNEL);
    subClient.on("message", (channel, message) => {
      if (channel !== CHANNEL) return;
      try {
        const { op, key, value } = JSON.parse(message);
        applyLocally(op, key, value);
      } catch (error) {
        console.error("⚠️ presenceSync: failed to apply replicated event:", error.message);
      }
    });
  }
};

// Applies locally right away (so the publishing pod doesn't wait on its own
// round-trip) and fans the mutation out to every other pod via Redis.
const publishSet = (key, value) => {
  applyLocally("set", key, value);
  pubClient.hset(HASH_KEY, key, JSON.stringify(value)).catch((err) =>
    console.error(`⚠️ presenceSync: failed to persist ${key} to Redis:`, err.message)
  );
  pubClient.publish(CHANNEL, JSON.stringify({ op: "set", key, value })).catch((err) =>
    console.error(`⚠️ presenceSync: failed to publish set for ${key}:`, err.message)
  );
};

const publishDel = (key) => {
  applyLocally("del", key);
  pubClient.hdel(HASH_KEY, key).catch((err) =>
    console.error(`⚠️ presenceSync: failed to delete ${key} from Redis:`, err.message)
  );
  pubClient.publish(CHANNEL, JSON.stringify({ op: "del", key })).catch((err) =>
    console.error(`⚠️ presenceSync: failed to publish del for ${key}:`, err.message)
  );
};

module.exports = { initPresenceSync, publishSet, publishDel };
