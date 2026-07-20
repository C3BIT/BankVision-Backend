const { Op } = require('sequelize');
const { ScheduledCall } = require('../models');

/**
 * Schedule a future callback for a customer
 * POST /api/scheduled-calls
 */
const createScheduledCall = async (req, res) => {
  try {
    const { customerPhone, customerName, accountNumber, notes, scheduledAt } = req.body;

    if (!customerPhone || !scheduledAt) {
      return res.status(400).json({
        success: false,
        message: 'Customer phone and scheduled time are required'
      });
    }

    const scheduledDate = new Date(scheduledAt);
    if (Number.isNaN(scheduledDate.getTime()) || scheduledDate <= new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Scheduled time must be a valid date in the future'
      });
    }

    const scheduledCall = await ScheduledCall.create({
      customerPhone,
      customerName,
      accountNumber,
      notes,
      scheduledAt: scheduledDate,
      managerId: req.user.id,
      managerEmail: req.user.email
    });

    res.status(201).json({
      success: true,
      message: 'Call scheduled successfully',
      data: scheduledCall
    });
  } catch (error) {
    console.error('Create Scheduled Call Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to schedule call'
    });
  }
};

/**
 * List scheduled calls for the authenticated manager
 * GET /api/scheduled-calls
 */
const listScheduledCalls = async (req, res) => {
  try {
    const { status } = req.query;

    const where = { managerId: req.user.id };
    if (status) {
      where.status = status;
    } else {
      where.status = { [Op.in]: ['pending', 'notified'] };
    }

    const scheduledCalls = await ScheduledCall.findAll({
      where,
      order: [['scheduledAt', 'ASC']]
    });

    res.json({
      success: true,
      data: scheduledCalls
    });
  } catch (error) {
    console.error('List Scheduled Calls Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to list scheduled calls'
    });
  }
};

/**
 * Update a pending scheduled call (time/notes)
 * PATCH /api/scheduled-calls/:id
 */
const updateScheduledCall = async (req, res) => {
  try {
    const { id } = req.params;
    const { scheduledAt, notes, customerName, accountNumber } = req.body;

    const scheduledCall = await ScheduledCall.findOne({ where: { id, managerId: req.user.id } });
    if (!scheduledCall) {
      return res.status(404).json({ success: false, message: 'Scheduled call not found' });
    }
    if (scheduledCall.status === 'completed' || scheduledCall.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'This scheduled call can no longer be edited' });
    }

    if (scheduledAt) {
      const scheduledDate = new Date(scheduledAt);
      if (Number.isNaN(scheduledDate.getTime()) || scheduledDate <= new Date()) {
        return res.status(400).json({ success: false, message: 'Scheduled time must be a valid date in the future' });
      }
      scheduledCall.scheduledAt = scheduledDate;
      scheduledCall.status = 'pending';
      scheduledCall.notifiedAt = null;
    }
    if (notes !== undefined) scheduledCall.notes = notes;
    if (customerName !== undefined) scheduledCall.customerName = customerName;
    if (accountNumber !== undefined) scheduledCall.accountNumber = accountNumber;

    await scheduledCall.save();

    res.json({ success: true, message: 'Scheduled call updated', data: scheduledCall });
  } catch (error) {
    console.error('Update Scheduled Call Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update scheduled call'
    });
  }
};

/**
 * Cancel a scheduled call
 * PATCH /api/scheduled-calls/:id/cancel
 */
const cancelScheduledCall = async (req, res) => {
  try {
    const { id } = req.params;
    const scheduledCall = await ScheduledCall.findOne({ where: { id, managerId: req.user.id } });
    if (!scheduledCall) {
      return res.status(404).json({ success: false, message: 'Scheduled call not found' });
    }

    scheduledCall.status = 'cancelled';
    await scheduledCall.save();

    res.json({ success: true, message: 'Scheduled call cancelled', data: scheduledCall });
  } catch (error) {
    console.error('Cancel Scheduled Call Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to cancel scheduled call'
    });
  }
};

/**
 * Mark a scheduled call as completed (manager made the callback)
 * PATCH /api/scheduled-calls/:id/complete
 */
const completeScheduledCall = async (req, res) => {
  try {
    const { id } = req.params;
    const scheduledCall = await ScheduledCall.findOne({ where: { id, managerId: req.user.id } });
    if (!scheduledCall) {
      return res.status(404).json({ success: false, message: 'Scheduled call not found' });
    }

    scheduledCall.status = 'completed';
    scheduledCall.completedAt = new Date();
    await scheduledCall.save();

    res.json({ success: true, message: 'Scheduled call marked as completed', data: scheduledCall });
  } catch (error) {
    console.error('Complete Scheduled Call Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to complete scheduled call'
    });
  }
};

module.exports = {
  createScheduledCall,
  listScheduledCalls,
  updateScheduledCall,
  cancelScheduledCall,
  completeScheduledCall
};
