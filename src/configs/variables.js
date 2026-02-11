require("dotenv").config(); // Load from .env

module.exports = {
  NODE_ENV: process.env.NODE_ENV || "production",
  PORT: process.env.PORT || 8086,
  jwtSecret: process.env.JWT_SECRET || "vb_jwt_secret",
  JWT_EXPIRATION: process.env.JWT_EXPIRATION,

  // Email config
  emailHost: process.env.EMAIL_HOST,
  emailPort: process.env.EMAIL_PORT,
  emailId: process.env.EMAIL_ID,
  emailPassword: process.env.EMAIL_PASSWORD,

  // DB config
  DB_NAME: process.env.DB_NAME || "vbrm",
  DB_USER: process.env.DB_USER || "doctel",
  DB_PASS: process.env.DB_PASS || "",
  DB_HOST: process.env.DB_HOST || "localhost",
  DB_PORT: process.env.DB_PORT || 3306,

  // SMS & Face APIs
  SMS_API_KEY: process.env.SMS_API_KEY || "N56VdU1npj7WQornOy79bRYiDtSUwO3fwr1lI3WZ",
  SMS_API_URL: process.env.SMS_API_URL || "https://api.sms.net.bd/sendsms",
  MXFACE_KEY: process.env.MXFACE_KEY || "X2KFQxxCOjlt6apA46-6rP9Qo7wdg3581",

  // DigitalOcean Spaces
  SPACES_BUCKET: process.env.SPACES_BUCKET || "doctel",
  SPACES_KEY: process.env.SPACES_KEY || "DO00XAMFRCBZK7E68E8C",
  SPACES_SECRET: process.env.SPACES_SECRET || "Cqu2oHKGEVk1MULCJMs6yaq1sNHqlcVG5CLyA3BZZqE",

  // AWS
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || "AKIA5DZ7OQA5SVDBU45L",
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || "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",
  AWS_REGION: process.env.AWS_REGION || "us-east-1",

  // OpenCV Face Service
  OPENCV_SERVICE_URL: process.env.OPENCV_SERVICE_URL || "http://localhost:5097",

  // Redis
  REDIS_HOST: process.env.REDIS_HOST || "localhost",
  REDIS_PORT: process.env.REDIS_PORT || 6379,
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
};
