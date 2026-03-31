const { userCache } = require("./memoryCache");

// Valid agent status types
const AGENT_STATUS = {
  ONLINE: 'online',
  BUSY: 'busy',
  BREAK: 'break',
  LUNCH: 'lunch',
  PRAYER: 'prayer',
  NOT_READY: 'not_ready',
  OFFLINE: 'offline'
};

// Call queue storage
const callQueue = [];

const addUserInCache = async (
  phone = null,
  role,
  socketId,
  name = "Manager",
  email = null
) => {
  if (!role || !socketId) {
    throw new Error("Role and socketId are required parameters");
  }

  if (role === "customer") {
    if (!phone || !socketId) {
      throw new Error("Customer requires phone and socketId");
    }
  } else if (role === "manager") {
    if (!email || !name || !socketId) {
      throw new Error("Manager requires email, name and socketId");
    }
  } else {
    throw new Error("Invalid role: must be either 'customer' or 'manager'");
  }

  const uniqueKey = role === "customer" ? phone : email;

  if (role === "customer") {
    userCache.set(uniqueKey, {
      phone,
      socketId,
      role,
      connectedAt: new Date().toISOString(),
    });
  } else {
    // For managers, try to restore previous status from Redis
    let status = "online"; // Default status
    try {
      const managerStatusService = require('../services/managerStatusService');
      const savedStatus = await managerStatusService.getManagerStatus(email);
      if (savedStatus && Object.values(AGENT_STATUS).includes(savedStatus)) {
        status = savedStatus;
        console.log(`♻️ Restored manager status from Redis: ${email} → ${status}`);
      } else {
        console.log(`🆕 New manager connection, setting status to online: ${email}`);
      }
    } catch (error) {
      console.error(`⚠️ Failed to restore manager status for ${email}:`, error);
      // Continue with default "online" status
    }

    userCache.set(uniqueKey, {
      email,
      name,
      socketId,
      role,
      status,
      connectedAt: new Date().toISOString(),
    });
  }

  return uniqueKey;
};


const getUserBySocketId = (socketId) => {
  const keys = userCache.keys();

  for (const key of keys) {
    const user = userCache.get(key);
    if (user && user.socketId === socketId) {
      return { ...user, uniqueKey: key };
    }
  }

  return null;
};


const removeUserInCache = (socketId) => {
  userCache.keys().forEach((key) => {
    if (userCache.get(key)?.socketId === socketId) {
      userCache.del(key);
    }
  });
};

const findAvailableManagers = () => {
  const managers = [];
  const keys = userCache.keys();
  
  for (const key of keys) {
    const user = userCache.get(key);
    if (user && user.role === "manager" && user.status === "online") {
      managers.push({
        email: user.email,
        name: user.name,
        socketId: user.socketId,
        ...(user.image && { image: user.image })
      });
    }
  }
  
  return managers;
};

const getOnlineUsersWithInfo = () => {
  const users = [];
  const keys = userCache.keys();
  
  for (const key of keys) {
    const user = userCache.get(key);
    if (user) {
      if (user.role === "customer") {
        users.push({
          phone: key,
          socketId: user.socketId,
          role: user.role
        });
      } else if (user.role === "manager") {
        users.push({
          email: key,
          name: user.name,
          socketId: user.socketId,
          role: user.role,
          status: user.status,
          ...(user.image && { image: user.image })
        });
      }
    }
  }
  
  return users;
};

const updateUserStatus = (email, role, status) => {
  if (role === "manager" && email) {
    const managerData = userCache.get(email);
    if (managerData) {
      // Validate status
      const validStatuses = Object.values(AGENT_STATUS);
      if (validStatuses.includes(status)) {
        managerData.status = status;
        managerData.statusChangedAt = new Date().toISOString();
        userCache.set(email, managerData);

        // Persist to Redis for status restoration on reconnect (fire-and-forget)
        const managerStatusService = require('../services/managerStatusService');
        managerStatusService.saveManagerStatus(email, status).catch(err => {
          console.error(`⚠️ Failed to persist manager status to Redis for ${email}:`, err);
        });

        return true;
      }
    }
  }
  return false;
};

// Call Queue Management
const addToCallQueue = (customerPhone, socketId, priority = 'normal') => {
  // Check if customer already in queue
  const existingIndex = callQueue.findIndex(q => q.customerPhone === customerPhone);
  if (existingIndex !== -1) {
    return null; // Already in queue
  }

  const queueEntry = {
    id: `q_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    customerPhone,
    socketId,
    priority, // 'high', 'normal', 'low'
    queuedAt: new Date().toISOString(),
    status: 'waiting'
  };

  // Insert based on priority
  if (priority === 'high') {
    // Find first non-high priority and insert before it
    const insertIndex = callQueue.findIndex(q => q.priority !== 'high');
    if (insertIndex === -1) {
      callQueue.push(queueEntry);
    } else {
      callQueue.splice(insertIndex, 0, queueEntry);
    }
  } else {
    callQueue.push(queueEntry);
  }

  return queueEntry;
};

const removeFromCallQueue = (customerPhone) => {
  const index = callQueue.findIndex(q => q.customerPhone === customerPhone);
  if (index !== -1) {
    return callQueue.splice(index, 1)[0];
  }
  return null;
};

const getCallQueue = () => {
  return [...callQueue];
};

const getQueuePosition = (customerPhone) => {
  const index = callQueue.findIndex(q => q.customerPhone === customerPhone);
  return index === -1 ? null : index + 1;
};

const getNextInQueue = () => {
  return callQueue.length > 0 ? callQueue[0] : null;
};

const updateQueueStatus = (customerPhone, status) => {
  const entry = callQueue.find(q => q.customerPhone === customerPhone);
  if (entry) {
    entry.status = status;
    return true;
  }
  return false;
};

// Get all managers with their statuses
const getAllManagers = () => {
  const managers = [];
  const keys = userCache.keys();

  for (const key of keys) {
    const user = userCache.get(key);
    if (user && user.role === "manager") {
      managers.push({
        email: user.email,
        name: user.name,
        socketId: user.socketId,
        status: user.status || 'offline',
        statusChangedAt: user.statusChangedAt,
        connectedAt: user.connectedAt,
        ...(user.image && { image: user.image })
      });
    }
  }

  return managers;
};

// Get queue statistics
const getQueueStats = () => {
  const managers = getAllManagers();
  const onlineManagers = managers.filter(m => m.status === AGENT_STATUS.ONLINE);
  const busyManagers = managers.filter(m => m.status === AGENT_STATUS.BUSY);

  return {
    queueLength: callQueue.length,
    waitingCalls: callQueue.filter(q => q.status === 'waiting').length,
    totalManagers: managers.length,
    onlineManagers: onlineManagers.length,
    busyManagers: busyManagers.length,
    availableManagers: onlineManagers.length
  };
};

module.exports = {
  addUserInCache,
  getUserBySocketId,
  removeUserInCache,
  findAvailableManagers,
  getOnlineUsersWithInfo,
  updateUserStatus,
  addToCallQueue,
  removeFromCallQueue,
  getCallQueue,
  getQueuePosition,
  getNextInQueue,
  updateQueueStatus,
  getAllManagers,
  getQueueStats,
  AGENT_STATUS
};
