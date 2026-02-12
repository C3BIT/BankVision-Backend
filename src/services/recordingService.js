const { EgressClient, EncodedFileOutput, S3Upload, RoomCompositeEgressRequest } = require('livekit-server-sdk');
const { Recording } = require('../models');

// LiveKit/OpenVidu configuration
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

// MinIO configuration (from OpenVidu setup)
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT;
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY;
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY;
const MINIO_BUCKET = process.env.MINIO_BUCKET;

// Convert WSS URL to HTTPS for API calls
const getApiUrl = () => {
  return LIVEKIT_URL.replace('wss://', 'https://');
};

// Create Egress client
const createEgressClient = () => {
  return new EgressClient(getApiUrl(), LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
};

/**
 * Start recording a room
 * @param {string} roomName - The room to record
 * @param {object} options - Recording options
 * @returns {object} Recording info with egressId
 */
const startRecording = async (roomName, options = {}) => {
  try {
    const egressClient = createEgressClient();

    const {
      customerPhone,
      managerEmail,
      callLogId,
      recordedBy = 'system'
    } = options;

    // Create unique filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `recording_${roomName}_${timestamp}.mp4`;

    // Configure S3/MinIO output
    const s3Output = new S3Upload({
      accessKey: MINIO_ACCESS_KEY,
      secret: MINIO_SECRET_KEY,
      bucket: MINIO_BUCKET,
      region: 'us-east-1', // MinIO doesn't care about region
      endpoint: MINIO_ENDPOINT,
      forcePathStyle: true, // Required for MinIO
    });

    const fileOutput = new EncodedFileOutput({
      fileType: 0, // MP4
      filepath: filename,
      output: {
        case: 's3',
        value: s3Output,
      },
    });

    // Start room composite egress (records entire room)
    const egressInfo = await egressClient.startRoomCompositeEgress(
      roomName,
      {
        file: fileOutput,
      },
      {
        layout: 'grid',
        audioOnly: false,
        videoOnly: false,
      }
    );

    console.log(`🎬 Recording started for room ${roomName}, egressId: ${egressInfo.egressId}`);

    // Create recording entry in database
    const recording = await Recording.create({
      callRoom: roomName,
      customerPhone: customerPhone || 'unknown',
      managerEmail: managerEmail || 'unknown',
      callLogId: callLogId || null,
      status: 'recording',
      startTime: new Date(),
      egressId: egressInfo.egressId,
      recordedBy,
      metadata: {
        layout: 'grid',
        filename,
        bucket: MINIO_BUCKET,
      }
    });

    return {
      success: true,
      egressId: egressInfo.egressId,
      recordingId: recording.id,
      roomName,
      status: 'recording',
      message: 'Recording started successfully'
    };
  } catch (error) {
    console.error(`❌ Failed to start recording for room ${roomName}:`, error);
    throw error;
  }
};

/**
 * Stop recording a room
 * @param {string} egressId - The egress ID to stop
 * @returns {object} Stop result
 */
const stopRecording = async (egressId) => {
  try {
    const egressClient = createEgressClient();

    // Stop the egress
    await egressClient.stopEgress(egressId);
    console.log(`🛑 Recording stopped for egressId: ${egressId}`);

    // Update recording in database to processing
    const recording = await Recording.findOne({ where: { egressId } });
    if (recording) {
      const endTime = new Date();
      const duration = Math.floor((endTime - recording.startTime) / 1000);

      await recording.update({
        status: 'processing',
        endTime,
        duration,
      });
    }

    // Wait for egress to finish processing, then update file info
    setTimeout(async () => {
      try {
        await finalizeRecording(egressId);
      } catch (err) {
        console.error(`❌ Failed to finalize recording ${egressId}:`, err.message);
      }
    }, 15000); // Wait 15 seconds for processing

    return {
      success: true,
      egressId,
      status: 'processing',
      message: 'Recording stopped, processing...'
    };
  } catch (error) {
    console.error(`❌ Failed to stop recording ${egressId}:`, error);
    throw error;
  }
};

/**
 * Finalize recording - get file info from egress and copy if needed
 */
const finalizeRecording = async (egressId) => {
  const egressClient = createEgressClient();
  const { exec } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  // Get egress info
  const egressList = await egressClient.listEgress({ egressId });
  const egressInfo = egressList.find(e => e.egressId === egressId);

  if (!egressInfo) {
    console.log(`⚠️ Egress ${egressId} not found`);
    return;
  }

  // Check if completed (status 3)
  if (egressInfo.status !== 3) {
    console.log(`⏳ Egress ${egressId} still processing (status: ${egressInfo.status})`);
    // Retry after 10 seconds
    setTimeout(() => finalizeRecording(egressId), 10000);
    return;
  }

  const recording = await Recording.findOne({ where: { egressId } });
  if (!recording) return;

  const fileResult = egressInfo.fileResults?.[0];
  if (!fileResult) {
    await recording.update({ status: 'failed' });
    return;
  }

  const filename = fileResult.filename;
  const fileSize = parseInt(fileResult.size);
  const durationNs = parseInt(fileResult.duration);
  const duration = Math.floor(durationNs / 1000000000);

  // Check if file is in backup storage (MinIO upload failed)
  if (fileResult.location.includes('/home/egress/backup_storage/')) {
    console.log(`📁 Copying recording from egress container: ${filename}`);

    const uploadsDir = path.join(__dirname, '../../uploads/recordings');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const localPath = path.join(uploadsDir, filename);

    // Copy from egress container
    await new Promise((resolve, reject) => {
      exec(`docker cp egress:/home/egress/backup_storage/${filename} ${localPath}`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await recording.update({
      status: 'completed',
      filePath: filename,
      storageUrl: `/uploads/recordings/${filename}`,
      fileSize,
      duration,
    });

    console.log(`✅ Recording finalized: ${filename}`);
  } else {
    // File is in MinIO
    await recording.update({
      status: 'completed',
      filePath: filename,
      storageUrl: fileResult.location,
      fileSize,
      duration,
    });

    console.log(`✅ Recording finalized (MinIO): ${filename}`);
  }
};

/**
 * Get recording status
 * @param {string} egressId - The egress ID to check
 * @returns {object} Recording status
 */
const getRecordingStatus = async (egressId) => {
  try {
    const egressClient = createEgressClient();

    // List egress to find the specific one
    const egressList = await egressClient.listEgress({ egressId });
    const egressInfo = egressList.find(e => e.egressId === egressId);

    if (!egressInfo) {
      throw new Error('Recording not found');
    }

    // Map egress status to our status
    let status;
    switch (egressInfo.status) {
      case 0: status = 'starting'; break;
      case 1: status = 'recording'; break;
      case 2: status = 'ending'; break;
      case 3: status = 'completed'; break;
      case 4: status = 'failed'; break;
      default: status = 'unknown';
    }

    // Update database if completed
    if (status === 'completed' || status === 'failed') {
      const recording = await Recording.findOne({ where: { egressId } });
      if (recording && recording.status !== status) {
        const updateData = { status };

        // If completed, get file info
        if (status === 'completed' && egressInfo.fileResults && egressInfo.fileResults.length > 0) {
          const fileResult = egressInfo.fileResults[0];
          updateData.filePath = fileResult.filename;
          updateData.fileSize = fileResult.size;
          updateData.storageUrl = fileResult.location;
          updateData.duration = Math.floor(fileResult.duration / 1000000000); // nanoseconds to seconds
        }

        await recording.update(updateData);
      }
    }

    return {
      success: true,
      egressId,
      status,
      info: egressInfo
    };
  } catch (error) {
    console.error(`❌ Failed to get recording status ${egressId}:`, error);
    throw error;
  }
};

/**
 * List active recordings
 * @param {string} roomName - Optional room name filter
 * @returns {array} Active recordings
 */
const listActiveRecordings = async (roomName = null) => {
  try {
    const egressClient = createEgressClient();

    const options = roomName ? { roomName } : {};
    const egressList = await egressClient.listEgress(options);

    // Filter for active recordings
    const activeRecordings = egressList.filter(e => e.status === 1);

    return {
      success: true,
      recordings: activeRecordings.map(e => ({
        egressId: e.egressId,
        roomName: e.roomName,
        startedAt: Number(e.startedAt), // Convert BigInt to Number
        status: 'recording'
      }))
    };
  } catch (error) {
    console.error(`❌ Failed to list active recordings:`, error);
    throw error;
  }
};

/**
 * Get recording download URL
 * @param {string} recordingId - Recording database ID
 * @returns {string} Download URL
 */
const getRecordingUrl = async (recordingId) => {
  try {
    const recording = await Recording.findByPk(recordingId);
    if (!recording) {
      throw new Error('Recording not found');
    }

    if (recording.status !== 'completed') {
      throw new Error('Recording not yet completed');
    }

    // Return MinIO URL (may need to generate presigned URL for production)
    return {
      success: true,
      url: recording.storageUrl || recording.filePath,
      filename: recording.metadata?.filename,
      duration: recording.duration,
      fileSize: recording.fileSize
    };
  } catch (error) {
    console.error(`❌ Failed to get recording URL:`, error);
    throw error;
  }
};

module.exports = {
  startRecording,
  stopRecording,
  getRecordingStatus,
  listActiveRecordings,
  getRecordingUrl
};
