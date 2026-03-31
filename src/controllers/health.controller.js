const sequelize = require('../configs/sequelize');
const { callQueue } = require('../services/callQueueService');
const { transporter } = require('../configs/mail_smtp');

const getHealth = async (req, res) => {
  try {
    // Check Database connection
    let dbStatus = "connected";
    try {
      if (!sequelize) {
        console.error("CRITICAL: sequelize object is UNDEFINED in health controller");
        dbStatus = "disconnected";
      } else {
        // Add a 5s timeout to the database authentication - prevents health check from hanging
        await Promise.race([
          sequelize.authenticate(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Database timeout')), 5000))
        ]);
      }
    } catch (err) {
      console.error("Database health check failed. Error type:", err.constructor.name);
      console.error("Error message:", err.message);
      dbStatus = "disconnected";
    }

    // Check Redis connection via BullMQ
    let redisStatus = "connected";
    const { connection } = require('../services/callQueueService');
    try {
      if (connection) {
        // Add a 5s timeout to the Redis ping
        await Promise.race([
          connection.ping(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Redis timeout')), 5000))
        ]);
      } else {
        redisStatus = "disconnected";
      }
    } catch (err) {
      console.error("Redis health check failed:", err.message);
      redisStatus = "disconnected";
    }
    // Check Email (SMTP) status
    let emailStatus = "connected";
    if (transporter) {
      try {
        await transporter.verify();
      } catch (err) {
        console.error("SMTP health check failed:", err.message);
        emailStatus = "disconnected";
      }
    } else {
      emailStatus = "not_configured";
    }

    const healthStatus = {
      status: (dbStatus === "connected" && redisStatus === "connected") ? "success" : "degraded",
      message: "System health check completed",
      data: {
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        services: {
          database: dbStatus,
          redis: redisStatus,
          email: emailStatus
        }
      },
    };

    // Always return 200 if the code reached this point (server is up)
    // to avoid the proxy/docker marking it as 503 and killing the service.
    res.status(200).json(healthStatus);
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