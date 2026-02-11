const express = require("express");
const { AccessToken } = require("livekit-server-sdk");
const router = express.Router();

// OpenVidu/LiveKit configuration
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "vbrm_openvidu_key";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "vbrm_openvidu_secret_2024_secure_key";

/**
 * Generate a LiveKit access token for a participant
 * POST /api/openvidu/token
 * Body: { roomName: string, participantName: string, participantIdentity?: string }
 */
router.post("/token", async (req, res) => {
  try {
    const { roomName, participantName, participantIdentity } = req.body;

    if (!roomName || !participantName) {
      return res.status(400).json({
        success: false,
        message: "roomName and participantName are required",
      });
    }

    // Create a unique identity for the participant
    const identity = participantIdentity || `${participantName}-${Date.now()}`;

    // Create access token
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name: participantName,
      ttl: "24h", // Token valid for 24 hours
    });

    // Grant permissions for the room
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();

    // Use direct WebSocket connection to bypass Cloudflare proxy issues
    // Port 7880 is the LiveKit WebSocket port exposed by caddy-proxy
    const serverUrl = process.env.PUBLIC_LIVEKIT_URL || process.env.LIVEKIT_URL || "wss://openvidu.ucchash4vc.xyz";

    return res.status(200).json({
      success: true,
      data: {
        token,
        roomName,
        participantName,
        identity,
        serverUrl,
      },
    });
  } catch (error) {
    console.error("Error generating OpenVidu token:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to generate token",
      error: error.message,
    });
  }
});

/**
 * Get room info (optional endpoint for debugging)
 * GET /api/openvidu/room/:roomName
 */
router.get("/room/:roomName", async (req, res) => {
  try {
    const { roomName } = req.params;

    return res.status(200).json({
      success: true,
      data: {
        roomName,
        serverUrl: process.env.PUBLIC_LIVEKIT_URL || process.env.LIVEKIT_URL || "wss://openvidu.ucchash4vc.xyz",
      },
    });
  } catch (error) {
    console.error("Error getting room info:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to get room info",
      error: error.message,
    });
  }
});

module.exports = router;
