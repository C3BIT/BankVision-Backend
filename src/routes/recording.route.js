const express = require('express');
const router = express.Router();
const recordingService = require('../services/recordingService');
const { adminAuthenticateMiddleware } = require('../middlewares/adminAuthMiddleware');
const { Recording } = require('../models');

/**
 * POST /api/recording/start
 * Start recording a room (Admin only)
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
 * POST /api/recording/stop
 * Stop recording (Admin only)
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
 * GET /api/recording/status/:egressId
 * Get recording status (Admin only)
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
 * GET /api/recording/active
 * List active recordings (Admin only)
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
 * GET /api/recording/list
 * List all recordings with pagination (Admin only)
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
 * POST /api/recording/sync
 * Sync all recordings status (Admin only)
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
 * GET /api/recording/:id
 * Get recording details (Admin only)
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
 * GET /api/recording/:id/download
 * Download recording file (Admin only)
 * Supports token via Authorization header or query param
 */
router.get('/:id/download', async (req, res) => {
  try {
    // Check for token in query string (for direct download links)
    if (req.query.token && !req.headers.authorization) {
      req.headers.authorization = `Bearer ${req.query.token}`;
    }

    // Manually verify admin token
    const jwt = require('jsonwebtoken');
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
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
    const http = require('http');

    const storageUrl = recording.storageUrl || '';
    const filename = recording.filePath || path.basename(storageUrl);

    // Check if file is in MinIO
    if (storageUrl.includes('openvidu-minio') || storageUrl.includes('minio')) {
      console.log('Streaming from MinIO:', storageUrl);

      // Set headers for download
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'video/mp4');

      // Proxy from MinIO
      http.get(storageUrl, (minioRes) => {
        if (minioRes.statusCode !== 200) {
          console.error('MinIO error:', minioRes.statusCode);
          if (!res.headersSent) {
            return res.status(404).json({ success: false, message: 'Recording file not found in storage' });
          }
          return;
        }

        if (minioRes.headers['content-length']) {
          res.setHeader('Content-Length', minioRes.headers['content-length']);
        }

        minioRes.pipe(res);

        minioRes.on('end', () => {
          console.log('MinIO stream completed:', filename);
        });

        minioRes.on('error', (err) => {
          console.error('MinIO stream error:', err);
        });
      }).on('error', (err) => {
        console.error('MinIO request error:', err);
        if (!res.headersSent) {
          res.status(500).json({ success: false, message: 'Error fetching from storage' });
        }
      });

      return;
    }

    // Local file path
    let filePath = storageUrl || recording.filePath;
    if (filePath.startsWith('/uploads/')) {
      filePath = path.join(__dirname, '../..', filePath.substring(1));
    } else if (!path.isAbsolute(filePath)) {
      filePath = path.join(__dirname, '../../uploads/recordings', filePath);
    }

    console.log('Download file path:', filePath);

    // Check file exists
    if (!fs.existsSync(filePath)) {
      console.log('File not found:', filePath);
      return res.status(404).json({ success: false, message: 'Recording file not found' });
    }

    // Get file stats
    const stat = fs.statSync(filePath);

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

/**
 * DELETE /api/recording/:id
 * Delete recording (Admin only - soft delete)
 */
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
