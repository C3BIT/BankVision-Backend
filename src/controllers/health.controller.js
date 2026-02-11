const sequelize = require('../configs/sequelize');
const { callQueue } = require('../services/callQueueService');

const getHealth = async (req, res) => {
  try {
    // Check Database connection
    let dbStatus = "connected";
    try {
      if (!sequelize) {
        console.error("CRITICAL: sequelize object is UNDEFINED in health controller");
      }
      await sequelize.authenticate();
    } catch (err) {
      console.error("Database health check failed. Error type:", err.constructor.name);
      console.error("Error message:", err.message);
      dbStatus = "disconnected";
    }

    // Check Redis connection via BullMQ
    let redisStatus = "connected";
    try {
      const client = await callQueue.client;
      await client.ping();
    } catch (err) {
      console.error("Redis health check failed:", err);
      redisStatus = "disconnected";
    }

    const healthStatus = {
      status: (dbStatus === "connected" && redisStatus === "connected") ? "success" : "degraded",
      message: "System health check completed",
      data: {
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        services: {
          database: dbStatus,
          redis: redisStatus
        }
      },
    };

    const statusCode = healthStatus.status === "success" ? 200 : 503;
    res.status(statusCode).json(healthStatus);
  } catch (error) {
    console.error("Health check error:", error);
    res.status(500).json({
      status: "error",
      message: "Internal Server Error",
      error: error.message,
    });
  }
};

module.exports = {
  getHealth
};