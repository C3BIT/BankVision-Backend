const express = require("express");
const { AccessToken } = require("livekit-server-sdk");
const jwt = require("jsonwebtoken");
const { jwtSecret } = require("../configs/variables");
const { getTokenFromRequest } = require("../utils/cookieHelper");
const { statusCodes } = require("../utils/statusCodes");
const router = express.Router();

// OpenVidu/LiveKit configuration — must be set via environment variables
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set in environment');
}

// Only a real, signed session may mint a room token. Previously this endpoint
// was fully unauthenticated: anyone could POST a guessed roomName
// (room_<phone>_<timestamp>) and receive a join+publish+subscribe token for a
// live customer↔manager KYC call. Accept any of the platform's three session
// cookies (customer / manager / admin), and — for customers — additionally
// bind the token to their OWN room so one verified customer can't join
// another's call.
const authenticateRoomRequester = (req, res, next) => {
  const raw =
    getTokenFromRequest(req, "customer_auth_token") ||
    getTokenFromRequest(req, "manager_auth_token") ||
    getTokenFromRequest(req, "admin_auth_token");
  if (!raw) {
    return res.status(statusCodes.UNAUTHORIZED).json({
      success: false,
      message: "Authentication required",
    });
  }
  try {
    const decoded = jwt.verify(raw, jwtSecret, { algorithms: ["HS256"] });
    req.roomRequester = decoded;
    return next();
  } catch (_err) {
    return res.status(statusCodes.UNAUTHORIZED).json({
      success: false,
      message: "Invalid or expired session",
    });
  }
};

// A customer may only receive a token for a room named after their own
// OTP-verified phone (room naming: room_<customerPhone>_<timestamp>, see
// socketHandler). Staff (manager/admin/supervisor) are trusted to join any
// room they are handling.
const requesterMayJoinRoom = (requester, roomName) => {
  const role = requester.type === "admin" ? "admin" : requester.role;
  if (role !== "customer") return true; // manager / admin / supervisor
  if (!requester.phone) return false;
  const roomDigits = String(roomName).replace(/\D/g, "");
  const phoneDigits = String(requester.phone).replace(/\D/g, "");
  return phoneDigits.length > 0 && roomDigits.includes(phoneDigits);
};

/**
 * @swagger
 * tags:
 *   name: OpenVidu
 *   description: LiveKit/OpenVidu room token issuance
 */

/**
 * @swagger
 * /openvidu/token:
 *   post:
 *     summary: Generate a LiveKit access token for a participant
 *     tags: [OpenVidu]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [roomName, participantName]
 *             properties:
 *               roomName: { type: string }
 *               participantName: { type: string }
 *               participantIdentity: { type: string }
 *     responses:
 *       200: { description: "{ token, roomName, participantName, identity, serverUrl }" }
 *       400: { description: Missing roomName/participantName }
 */
router.post("/token", authenticateRoomRequester, async (req, res) => {
  try {
    const { roomName, participantName, participantIdentity } = req.body;

    if (!roomName || !participantName) {
      return res.status(400).json({
        success: false,
        message: "roomName and participantName are required",
      });
    }

    if (!requesterMayJoinRoom(req.roomRequester, roomName)) {
      return res.status(statusCodes.FORBIDDEN).json({
        success: false,
        message: "Not authorized to join this room",
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
    const serverUrl = process.env.PUBLIC_LIVEKIT_URL || process.env.LIVEKIT_URL;

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
 * @swagger
 * /openvidu/room/{roomName}:
 *   get:
 *     summary: Get room info (debugging)
 *     tags: [OpenVidu]
 *     parameters:
 *       - in: path
 *         name: roomName
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Room info }
 */
router.get("/room/:roomName", authenticateRoomRequester, async (req, res) => {
  try {
    const { roomName } = req.params;

    return res.status(200).json({
      success: true,
      data: {
        roomName,
        serverUrl: process.env.PUBLIC_LIVEKIT_URL || process.env.LIVEKIT_URL,
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
