const { Op } = require('sequelize');
const { ScheduledCall } = require('../models');
const { getOnlineUsersWithInfo } = require('../utils/cacheService');

/**
 * Find scheduled calls whose time has arrived and notify the owning
 * manager over their live socket, if connected. Runs on a fixed
 * interval rather than a delayed BullMQ job since the existing
 * call-queue Worker is not run in production (see index.js).
 */
const checkDueScheduledCalls = async (io) => {
  try {
    const dueCalls = await ScheduledCall.findAll({
      where: {
        status: 'pending',
        scheduledAt: { [Op.lte]: new Date() }
      }
    });

    if (dueCalls.length === 0) return;

    const onlineManagers = getOnlineUsersWithInfo();

    for (const call of dueCalls) {
      const managerSocketId = onlineManagers.find(
        (user) => user.email === call.managerEmail
      )?.socketId;

      if (managerSocketId) {
        io.to(managerSocketId).emit('schedule:due', {
          id: call.id,
          customerPhone: call.customerPhone,
          customerName: call.customerName,
          accountNumber: call.accountNumber,
          notes: call.notes,
          scheduledAt: call.scheduledAt
        });
        console.log(`⏰ Scheduled call reminder sent to ${call.managerEmail} for ${call.customerPhone}`);
      } else {
        console.log(`⏰ Scheduled call due for ${call.managerEmail} (offline) — will remain visible in their list`);
      }

      call.status = 'notified';
      call.notifiedAt = new Date();
      await call.save();
    }
  } catch (error) {
    console.error('Check Due Scheduled Calls Error:', error);
  }
};

module.exports = { checkDueScheduledCalls };
