const { Queue, Worker, QueueEvents } = require('bullmq');
const Redis = require('ioredis');

// Redis connection for BullMQ (connect to vbrm-redis container)
const connection = new Redis({
  host: process.env.REDIS_HOST || 'vbrm-redis',
  port: 6379,
  password: process.env.REDIS_PASSWORD || 'VbrmRedis2024Secure',
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Monitor Redis connection
connection.on('connect', () => {
  console.log('✅ BullMQ Redis connected');
});

connection.on('ready', () => {
  console.log('✅ BullMQ Redis ready to accept commands');
});

connection.on('error', (err) => {
  console.error('❌ BullMQ Redis connection error:', err);
});

connection.on('close', () => {
  console.log('⚠️ BullMQ Redis connection closed');
});

connection.on('reconnecting', () => {
  console.log('🔄 BullMQ Redis reconnecting...');
});

// Create call queue with Bull MQ
const callQueue = new Queue('call-routing', { connection });

// Queue events for monitoring
const queueEvents = new QueueEvents('call-routing', { connection });

// Priority mapping (lower number = higher priority)
const PRIORITY = {
  VIP: 1,       // Highest priority - VIP customers
  HIGH: 5,      // High priority - escalated calls
  NORMAL: 10,   // Normal priority - regular customers
  LOW: 15       // Low priority - callbacks, non-urgent
};

/**
 * Add customer to call queue with BullMQ
 * @param {Object} customerData - Customer information
 * @returns {Promise<Object>} Result with jobId and position
 */
async function addCustomerToQueue(customerData) {
  const {
    customerPhone,
    socketId,
    customerName = null,
    customerEmail = null,
    priority = 'NORMAL',
    metadata = {}
  } = customerData;

  try {
    // Check if customer already in queue
    const existingJobs = await callQueue.getJobs(['waiting', 'delayed', 'active', 'prioritized']);
    const alreadyQueued = existingJobs.find(job => job.data.customerPhone === customerPhone);

    if (alreadyQueued) {
      const position = await getQueuePosition(customerPhone);
      console.log(`⚠️ Customer ${customerPhone} already in queue at position ${position}`);
      return {
        success: false,
        alreadyInQueue: true,
        jobId: alreadyQueued.id,
        queuePosition: position
      };
    }

    // Add job to queue with priority
    console.log(`📝 Adding job to BullMQ queue: ${customerPhone}`);
    const job = await callQueue.add(
      'route-call',
      {
        customerPhone,
        socketId,
        customerName,
        customerEmail,
        queuedAt: new Date().toISOString(),
        ...metadata
      },
      {
        priority: PRIORITY[priority] || PRIORITY.NORMAL,
        removeOnComplete: {
          age: 3600, // Keep completed jobs for 1 hour
          count: 100 // Keep last 100 completed jobs
        },
        removeOnFail: false, // Keep failed jobs for debugging
        attempts: 3, // Retry 3 times if routing fails
        backoff: {
          type: 'exponential',
          delay: 5000, // 5s, 25s, 125s
        },
        jobId: `customer-${customerPhone}-${Date.now()}`, // Unique ID
      }
    );

    console.log(`📝 Job created with ID: ${job.id}, awaiting state...`);
    const jobState = await job.getState();
    console.log(`📝 Job state: ${jobState}`);

    const position = await getQueuePosition(customerPhone);
    console.log(`✅ Customer ${customerPhone} added to BullMQ queue with priority ${priority} at position ${position}`);

    return {
      success: true,
      jobId: job.id,
      queuePosition: position
    };
  } catch (error) {
    console.error('❌ Failed to add customer to BullMQ queue:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Remove customer from queue (cancel call)
 * @param {string} customerPhone - Customer phone number
 * @returns {Promise<boolean>} Success status
 */
async function removeCustomerFromQueue(customerPhone) {
  try {
    const jobs = await callQueue.getJobs(['waiting', 'delayed', 'active', 'prioritized']);
    const customerJob = jobs.find(job => job.data.customerPhone === customerPhone);

    if (customerJob) {
      await customerJob.remove();
      console.log(`✅ Customer ${customerPhone} removed from BullMQ queue`);
      return true;
    }

    console.log(`⚠️ Customer ${customerPhone} not found in queue`);
    return false;
  } catch (error) {
    console.error('❌ Failed to remove customer from BullMQ queue:', error);
    return false;
  }
}

/**
 * Get queue position for customer
 * @param {string} customerPhone - Customer phone number
 * @returns {Promise<number|null>} Position in queue (1-indexed) or null
 */
async function getQueuePosition(customerPhone) {
  try {
    const jobs = await callQueue.getJobs(['waiting', 'delayed', 'prioritized']);
    // Sort by priority (ascending) and timestamp
    jobs.sort((a, b) => {
      if (a.opts.priority !== b.opts.priority) {
        return a.opts.priority - b.opts.priority;
      }
      return new Date(a.data.queuedAt) - new Date(b.data.queuedAt);
    });

    const index = jobs.findIndex(job => job.data.customerPhone === customerPhone);
    return index === -1 ? null : index + 1;
  } catch (error) {
    console.error('❌ Failed to get queue position:', error);
    return null;
  }
}

/**
 * Get queue statistics
 * @returns {Promise<Object>} Queue stats including counts and averages
 */
async function getQueueStats() {
  try {
    // If Redis is not ready, return empty stats immediately to avoid hang
    if (connection.status !== 'ready') {
      console.warn('⚠️ Redis not ready, returning empty queue stats');
      return {
        waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0,
        total: 0, avgWaitTimeSeconds: 0, serviceLevel: 100
      };
    }

    const [waiting, active, delayed, completed, failed] = await Promise.all([
      callQueue.getWaitingCount(),
      callQueue.getActiveCount(),
      callQueue.getDelayedCount(),
      callQueue.getCompletedCount(),
      callQueue.getFailedCount(),
    ]);

    // Get average wait time from last 100 completed jobs
    const recentJobs = await callQueue.getCompleted(0, 99);
    const waitTimes = recentJobs.map(job => {
      const queuedAt = new Date(job.data.queuedAt).getTime();
      const processedAt = job.processedOn || job.finishedOn;
      return processedAt ? processedAt - queuedAt : 0;
    }).filter(time => time > 0);

    const avgWaitTime = waitTimes.length > 0
      ? waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length
      : 0;

    // Calculate service level (% answered within 30 seconds)
    const answeredUnder30s = waitTimes.filter(time => time < 30000).length;
    const serviceLevel = waitTimes.length > 0
      ? (answeredUnder30s / waitTimes.length * 100).toFixed(1)
      : 100;

    return {
      waiting,
      active,
      delayed,
      completed,
      failed,
      total: waiting + active + delayed,
      avgWaitTimeSeconds: Math.round(avgWaitTime / 1000),
      serviceLevel: parseFloat(serviceLevel),
      answeredCalls: completed,
      failedCalls: failed
    };
  } catch (error) {
    console.error('❌ Failed to get BullMQ queue stats:', error);
    return {
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
      total: 0,
      avgWaitTimeSeconds: 0,
      serviceLevel: 100
    };
  }
}

/**
 * Get all customers in queue with their details
 * @returns {Promise<Array>} Array of customer queue entries
 */
async function getQueuedCustomers() {
  try {
    if (connection.status !== 'ready') return [];

    // CRITICAL: Include 'prioritized' state - BullMQ jobs start in this state before transitioning to 'waiting'
    const jobs = await callQueue.getJobs(['waiting', 'delayed', 'active', 'prioritized']);

    console.log(`📋 BullMQ getQueuedCustomers: Found ${jobs.length} jobs in queue`);
    if (jobs.length > 0) {
      console.log(`   Jobs: ${jobs.map(j => `${j.data.customerPhone} (${j.id}, state: ${j.finishedOn ? 'done' : 'pending'})`).join(', ')}`);
    }

    // Sort by priority and time
    jobs.sort((a, b) => {
      if (a.opts.priority !== b.opts.priority) {
        return a.opts.priority - b.opts.priority;
      }
      return new Date(a.data.queuedAt) - new Date(b.data.queuedAt);
    });

    // Get all states in parallel
    const states = await Promise.all(jobs.map(job => job.getState()));

    return jobs.map((job, index) => ({
      id: job.id,
      customerPhone: job.data.customerPhone,
      customerName: job.data.customerName,
      customerEmail: job.data.customerEmail,
      socketId: job.data.socketId,
      priority: Object.keys(PRIORITY).find(key => PRIORITY[key] === job.opts.priority) || 'NORMAL',
      queuedAt: job.data.queuedAt,
      position: index + 1,
      waitTimeSeconds: Math.round((Date.now() - new Date(job.data.queuedAt).getTime()) / 1000),
      status: states[index],
      attempts: job.attemptsMade,
      verificationInfo: job.data.verificationInfo || null, // { method: 'phone'|'email', phoneOrEmail: '...', isInternal: true|false }
    }));
  } catch (error) {
    console.error('❌ Failed to get queued customers:', error);
    return [];
  }
}

/**
 * Escalate old calls that have been waiting too long
 * @param {Object} io - Socket.IO instance
 * @returns {Promise<void>}
 */
async function escalateOldCalls(io) {
  try {
    const jobs = await callQueue.getJobs(['waiting', 'delayed', 'prioritized']);
    const now = Date.now();
    const escalationThreshold = 5 * 60 * 1000; // 5 minutes

    for (const job of jobs) {
      const waitTime = now - new Date(job.data.queuedAt).getTime();

      // Escalate if waiting more than threshold and not already VIP priority
      if (waitTime > escalationThreshold && job.opts.priority !== PRIORITY.VIP) {
        // Upgrade to HIGH priority
        await job.changePriority({ priority: PRIORITY.HIGH });

        // Notify customer
        const customerSocket = io.sockets.sockets.get(job.data.socketId);
        if (customerSocket) {
          customerSocket.emit('queue:escalated', {
            message: 'Your call has been escalated due to wait time. A supervisor has been notified.',
            waitTimeSeconds: Math.round(waitTime / 1000),
            newPriority: 'HIGH'
          });
        }

        // Notify all supervisors
        io.emit('queue:escalation', {
          customerPhone: job.data.customerPhone,
          customerName: job.data.customerName,
          waitTimeSeconds: Math.round(waitTime / 1000),
          priority: 'HIGH'
        });

        console.log(`⬆️ Escalated call for ${job.data.customerPhone} to HIGH priority after ${Math.round(waitTime / 1000)}s wait`);
      }
    }
  } catch (error) {
    console.error('❌ Failed to escalate old calls:', error);
  }
}

/**
 * Clean up disconnected customers from queue
 * @param {Object} io - Socket.IO instance
 * @returns {Promise<number>} Number of customers removed
 */
async function cleanupDisconnectedCustomers(io) {
  try {
    const jobs = await callQueue.getJobs(['waiting', 'delayed', 'prioritized']);
    let removedCount = 0;

    for (const job of jobs) {
      const socket = io.sockets.sockets.get(job.data.socketId);
      if (!socket || !socket.connected) {
        await job.remove();
        removedCount++;
        console.log(`🧹 Removed disconnected customer ${job.data.customerPhone} from queue`);
      }
    }

    if (removedCount > 0) {
      console.log(`✅ Cleaned up ${removedCount} disconnected customers from queue`);
    }

    return removedCount;
  } catch (error) {
    console.error('❌ Failed to cleanup disconnected customers:', error);
    return 0;
  }
}

// Monitor queue events for logging
queueEvents.on('waiting', ({ jobId }) => {
  console.log(`📋 BullMQ: Job ${jobId} is waiting`);
});

queueEvents.on('active', ({ jobId }) => {
  console.log(`🔄 BullMQ: Job ${jobId} is now active (processing)`);
});

queueEvents.on('completed', ({ jobId, returnvalue }) => {
  console.log(`✅ BullMQ: Job ${jobId} completed successfully`);
});

queueEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(`❌ BullMQ: Job ${jobId} failed: ${failedReason}`);
});

queueEvents.on('removed', ({ jobId }) => {
  console.log(`🗑️ BullMQ: Job ${jobId} removed from queue`);
});

module.exports = {
  connection,
  callQueue,
  queueEvents,
  addCustomerToQueue,
  removeCustomerFromQueue,
  getQueuePosition,
  getQueueStats,
  getQueuedCustomers,
  escalateOldCalls,
  cleanupDisconnectedCustomers,
  PRIORITY
};
