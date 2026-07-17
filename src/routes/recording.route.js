const express = require('express');
const router = express.Router();
const recordingService = require('../services/recordingService');
const { adminAuthenticateMiddleware } = require('../middlewares/adminAuthMiddleware');
const { Recording } = require('../models');

/**
 * @swagger
 * tags:
 *   name: Recording
 *   description: LiveKit egress recording control and management (admin only)
 */

/**
 * @swagger
 * /recording/start:
 *   post:
 *     summary: Start recording a room
 *     tags: [Recording]
 *     responses:
 *       200: { description: Recording started }
 *       400: { description: Room name required }
 */
router.post('/start', adminAuthenticateMiddleware, async (req, res) => {
  try {
    const { roomName, customerPhone, managerEmail, callLogId } = req.body;

    if (!roomName) {
      return res.status(400).json({
        success: false,
        message: 'Room name is required'
      });
    }

    const result = await recordingService.startRecording(roomName, {
      customerPhone,
      managerEmail,
      callLogId,
      recordedBy: req.admin.email || 'admin'
    });

    res.json(result);
  } catch (error) {
    console.error('Start recording error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to start recording'
    });
  }
});

/**
 * @swagger
 * /recording/stop:
 *   post:
 *     summary: Stop an active recording
 *     tags: [Recording]
 *     responses:
 *       200: { description: Recording stopped }
 *       400: { description: egressId or recordingId required }
 */
router.post('/stop', adminAuthenticateMiddleware, async (req, res) => {
  try {
    const { egressId, recordingId } = req.body;

    let targetEgressId = egressId;

    // If recordingId provided, get egressId from database
    if (!targetEgressId && recordingId) {
      const recording = await Recording.findByPk(recordingId);
      if (recording) {
        targetEgressId = recording.egressId;
      }
    }

    if (!targetEgressId) {
      return res.status(400).json({
        success: false,
        message: 'Egress ID or Recording ID is required'
      });
    }

    const result = await recordingService.stopRecording(targetEgressId);
    res.json(result);
  } catch (error) {
    console.error('Stop recording error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to stop recording'
    });
  }
});

/**
 * @swagger
 * /recording/status/{egressId}:
 *   get:
 *     summary: Get recording status by egress ID
 *     tags: [Recording]
 *     parameters:
 *       - in: path
 *         name: egressId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Recording status }
 */
router.get('/status/:egressId', adminAuthenticateMiddleware, async (req, res) => {
  try {
    const { egressId } = req.params;
    const result = await recordingService.getRecordingStatus(egressId);
    res.json(result);
  } catch (error) {
    console.error('Get recording status error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get recording status'
    });
  }
});

/**
 * @swagger
 * /recording/active:
 *   get:
 *     summary: List active recordings
 *     tags: [Recording]
 *     parameters:
 *       - in: query
 *         name: roomName
 *         schema: { type: string }
 *     responses:
 *       200: { description: Active recordings }
 */
router.get('/active', adminAuthenticateMiddleware, async (req, res) => {
  try {
    const { roomName } = req.query;
    const result = await recordingService.listActiveRecordings(roomName);
    res.json(result);
  } catch (error) {
    console.error('List active recordings error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to list active recordings'
    });
  }
});

/**
 * @swagger
 * /recording/list:
 *   get:
 *     summary: List all recordings with pagination
 *     tags: [Recording]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: customerPhone
 *         schema: { type: string }
 *       - in: query
 *         name: managerEmail
 *         schema: { type: string }
 *     responses:
 *       200: { description: Paginated recordings list }
 */
router.get('/list', adminAuthenticateMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, customerPhone, managerEmail } = req.query;
    const offset = (page - 1) * limit;

    const where = {};
    if (status) where.status = status;
    if (customerPhone) where.customerPhone = customerPhone;
    if (managerEmail) where.managerEmail = managerEmail;

    const { count, rows } = await Recording.findAndCountAll({
      where,
      order: [['startTime', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    res.json({
      success: true,
      recordings: rows,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('List recordings error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to list recordings'
    });
  }
});

/**
 * @swagger
 * /recording/sync:
 *   post:
 *     summary: Sync all recording statuses from LiveKit egress
 *     tags: [Recording]
 *     responses:
 *       200: { description: Sync result }
 */
router.post('/sync', adminAuthenticateMiddleware, async (req, res) => {
  try {
    const result = await recordingService.syncRecordings();
    res.json(result);
  } catch (error) {
    console.error('Sync recordings error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to sync recordings'
    });
  }
});

/**
 * @swagger
 * /recording/{id}:
 *   get:
 *     summary: Get recording details
 *     tags: [Recording]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Recording details }
 *       404: { description: Not found }
 *   delete:
 *     summary: Soft-delete a recording
 *     tags: [Recording]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Recording deleted }
 *       404: { description: Not found }
 */
router.get('/:id', adminAuthenticateMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const recording = await Recording.findByPk(id);

    if (!recording) {
      return res.status(404).json({
        success: false,
        message: 'Recording not found'
      });
    }

    // If recording has egressId, get latest status
    if (recording.egressId && recording.status === 'recording') {
      try {
        await recordingService.getRecordingStatus(recording.egressId);
        await recording.reload();
      } catch (e) {
        // Ignore status check errors
      }
    }

    res.json({
      success: true,
      recording
    });
  } catch (error) {
    console.error('Get recording error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get recording'
    });
  }
});

/**
 * @swagger
 * /recording/{id}/download:
 *   get:
 *     summary: Download a recording file (token via header or ?token= query param)
 *     tags: [Recording]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: token
 *         schema: { type: string }
 *     responses:
 *       200: { description: Recording file stream }
 *       401: { description: Missing/invalid token }
 *       403: { description: Admin access required }
 *       404: { description: Not found }
 */
router.get('/:id/download', async (req, res) => {
  try {
    // Manually verify admin token — Authorization header or ?token= query param (for video players)
    const jwt = require('jsonwebtoken');
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (!token) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      // Accept admin, super_admin, or type=admin
      if (decoded.role !== 'admin' && decoded.role !== 'super_admin' && decoded.type !== 'admin') {
        return res.status(403).json({ success: false, message: 'Admin access required' });
      }
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }

    const { id } = req.params;
    const recording = await Recording.findByPk(id);

    if (!recording) {
      return res.status(404).json({ success: false, message: 'Recording not found' });
    }

    if (recording.status !== 'completed') {
      return res.status(400).json({ success: false, message: 'Recording not yet completed' });
    }

    const path = require('path');
    const fs = require('fs');

    const filename = recording.filePath || '';

    // Check if file is in MinIO (filePath is just a filename, not a local path)
    const isMinioFile = filename && !filename.startsWith('/uploads');
    if (isMinioFile) {
      console.log(`Downloading from MinIO via S3 SDK: bucket=${process.env.MINIO_BUCKET}, key=${filename}`);

      const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
      const s3 = new S3Client({
        endpoint: process.env.MINIO_ENDPOINT,
        region: 'us-east-1',
        credentials: {
          accessKeyId: process.env.MINIO_ACCESS_KEY,
          secretAccessKey: process.env.MINIO_SECRET_KEY,
        },
        forcePathStyle: true,
      });

      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'video/mp4');

      const getResult = await s3.send(new GetObjectCommand({
        Bucket: process.env.MINIO_BUCKET,
        Key: filename,
      }));

      if (getResult.ContentLength) {
        res.setHeader('Content-Length', getResult.ContentLength);
      }
      getResult.Body.pipe(res);
      return;
    }

    // Local file path
    let filePath = recording.filePath;
    if (filePath.startsWith('/uploads/')) {
      filePath = path.join(__dirname, '../..', filePath.substring(1));
    } else if (!path.isAbsolute(filePath)) {
      filePath = path.join(__dirname, '../../uploads/recordings', filePath);
    }

    console.log('Download file path:', filePath);

    // Check file exists and get stats (async — avoids blocking event loop)
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return res.status(404).json({ success: false, message: 'Recording file not found' });
    }

    console.log('Streaming file:', filename, 'Size:', stat.size);

    // Set headers for download
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);

    // Stream the file
    const fileStream = fs.createReadStream(filePath);

    fileStream.on('error', (err) => {
      console.error('File stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Error streaming file' });
      }
    });

    fileStream.on('end', () => {
      console.log('File stream completed:', filename);
    });

    fileStream.pipe(res);
  } catch (error) {
    console.error('Download recording error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to download recording'
    });
  }
});

// Delete recording (Admin only - soft delete). Documented above with the GET /:id block.
router.delete('/:id', adminAuthenticateMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const recording = await Recording.findByPk(id);

    if (!recording) {
      return res.status(404).json({
        success: false,
        message: 'Recording not found'
      });
    }

    // If still recording, stop it first
    if (recording.status === 'recording' && recording.egressId) {
      try {
        await recordingService.stopRecording(recording.egressId);
      } catch (e) {
        // Continue with deletion
      }
    }

    await recording.update({ status: 'deleted' });

    res.json({
      success: true,
      message: 'Recording deleted successfully'
    });
  } catch (error) {
    console.error('Delete recording error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete recording'
    });
  }
});

module.exports = router;
