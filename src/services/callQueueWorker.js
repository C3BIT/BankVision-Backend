const { Worker } = require('bullmq');
const Redis = require('ioredis');

// Redis connection
const connection = new Redis({
  host: process.env.REDIS_HOST || 'vbrm-redis',
  port: 6379,
  password: process.env.REDIS_PASSWORD || 'VbrmRedis2024Secure',
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

let workerInstance = null;

/**
 * Start BullMQ worker to process call routing jobs
 * @param {Object} io - Socket.IO instance
 * @returns {Worker} Worker instance
 */
function startCallQueueWorker(io) {
  if (workerInstance) {
    console.log('⚠️ Call queue worker already running');
    return workerInstance;
  }

  workerInstance = new Worker(
    'call-routing',
    async (job) => {
      const { customerPhone, socketId, customerName, customerEmail } = job.data;

      console.log(`🔄 BullMQ Worker: Processing call routing for customer ${customerPhone}`);

      // Check if customer socket still connected
      const customerSocket = io.sockets.sockets.get(socketId);
      if (!customerSocket || !customerSocket.connected) {
        throw new Error(`Customer ${customerPhone} disconnected before routing`);
      }

      // Import helper functions from socketHandler
      const { findAvailableManagers } = require('../utils/cacheService');

      // Find available managers
      const availableManagers = findAvailableManagers();

      if (availableManagers.length === 0) {
        // No managers available - job will retry
        console.log(`⚠️ No managers available for customer ${customerPhone}, will retry`);
        throw new Error('No managers currently available');
      }

      // Get first available manager (in real implementation, could be more sophisticated routing)
      const selectedManager = availableManagers[0];
      console.log(`✅ Selected manager ${selectedManager.email} for customer ${customerPhone}`);

      // Import call routing helper from socketHandler
      const crypto = require('crypto');
      const { updateUserStatus, AGENT_STATUS } = require('../utils/cacheService');

      // Create call room
      const roomId = crypto
        .createHash('sha256')
        .update(`${customerPhone}_${selectedManager.email}_${Date.now()}`)
        .digest('hex')
        .slice(0, 16);

      const OPENVIDU_DOMAIN = process.env.OPENVIDU_DOMAIN;
      const callRoomLink = `https://${OPENVIDU_DOMAIN}/${roomId}`;

      // Update manager status to busy
      updateUserStatus(selectedManager.email, 'manager', AGENT_STATUS.BUSY);

      // Get manager socket
      const managerSocket = io.sockets.sockets.get(selectedManager.socketId);
      if (!managerSocket) {
        throw new Error(`Manager ${selectedManager.email} socket not found`);
      }

      // Store customer phone on manager socket for tracking
      managerSocket.user.customerPhone = customerPhone;

      // Fetch customer info from CBS (optional)
      let customerInfo = {};
      try {
        const cbsMockService = require('./cbsService');
        const cbsData = await cbsMockService.lookupCustomerByPhone(customerPhone);
        if (cbsData.found) {
          customerInfo = {
            customerName: cbsData.name,
            customerEmail: cbsData.email,
            customerImage: cbsData.profileImage,
          };
        }
      } catch (error) {
        console.error(`⚠️ Error fetching customer info for ${customerPhone}:`, error.message);
      }

      // Emit call request to manager
      managerSocket.emit('call:request', {
        customerId: customerPhone,
        customerSocketId: socketId,
        callRoom: roomId,
        customerPhone: customerPhone,
        fromQueue: true,
        ...customerInfo
      });

      // Notify customer that call is connecting
      customerSocket.emit('queue:call-connecting', {
        managerId: selectedManager.email,
        managerName: selectedManager.name || null,
        ...(selectedManager.image && { managerImage: selectedManager.image }),
        callRoom: roomId,
        message: 'A manager is now available. Connecting your call...'
      });

      // Broadcast updated manager list
      io.emit('manager:list', findAvailableManagers());

      console.log(`📞 BullMQ: Routed queued customer ${customerPhone} to manager ${selectedManager.email}`);
      console.log(`🔗 Call Room: ${roomId}`);

      // Return result for job completion
      return {
        success: true,
        managerEmail: selectedManager.email,
        managerName: selectedManager.name,
        callRoom: roomId,
        routedAt: new Date().toISOString(),
        routingTimeMs: Date.now() - new Date(job.data.queuedAt).getTime()
      };
    },
    {
      connection,
      concurrency: 5, // Process up to 5 calls simultaneously
      limiter: {
        max: 10, // Max 10 calls per...
        duration: 60000, // ...per minute (rate limiting)
      },
      removeOnComplete: {
        age: 3600, // Keep completed for 1 hour
        count: 100
      },
      removeOnFail: {
        age: 86400 // Keep failed jobs for 24 hours for debugging
      }
    }
  );

  // Handle successful job completion
  workerInstance.on('completed', (job, returnvalue) => {
    console.log(
      `✅ BullMQ Worker: Call routed successfully - ` +
      `Customer ${job.data.customerPhone} → Manager ${returnvalue.managerEmail} ` +
      `(Routing time: ${returnvalue.routingTimeMs}ms)`
    );
  });

  // Handle job failure
  workerInstance.on('failed', (job, err) => {
    console.error(
      `❌ BullMQ Worker: Call routing failed for customer ${job.data.customerPhone}: ${err.message}`
    );

    // If this was the last attempt, notify customer
    if (job.attemptsMade >= job.opts.attempts) {
      const customerSocket = io.sockets.sockets.get(job.data.socketId);
      if (customerSocket) {
        customerSocket.emit('queue:routing-failed', {
          message: 'Failed to connect your call after multiple attempts. Please try again.',
          error: err.message,
          attempts: job.attemptsMade
        });
      }
    }
  });

  // Handle worker errors
  workerInstance.on('error', (err) => {
    console.error('❌ BullMQ Worker error:', err);
  });

  // Handle worker ready
  workerInstance.on('ready', () => {
    console.log('✅ BullMQ call queue worker started and ready to process jobs');
  });

  // Handle graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('⏸️ SIGTERM received, closing BullMQ worker gracefully...');
    await workerInstance.close();
    process.exit(0);
  });

  return workerInstance;
}

/**
 * Stop the call queue worker
 * @returns {Promise<void>}
 */
async function stopCallQueueWorker() {
  if (workerInstance) {
    console.log('⏸️ Stopping BullMQ call queue worker...');
    await workerInstance.close();
    workerInstance = null;
    console.log('✅ BullMQ worker stopped');
  }
}

module.exports = {
  startCallQueueWorker,
  stopCallQueueWorker
};
