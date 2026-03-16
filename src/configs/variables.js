require('dotenv').config({ override: true }); // Load from .env and override process.env

module.exports = {
  NODE_ENV: process.env.NODE_ENV || "production",
  PORT: process.env.PORT || 3000,
  jwtSecret: (() => {
    if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');
    return process.env.JWT_SECRET;
  })(),
  JWT_EXPIRATION: process.env.JWT_EXPIRATION,

  // Email config
  emailHost: process.env.EMAIL_HOST,
  emailPort: process.env.EMAIL_PORT,
  emailId: process.env.EMAIL_ID,
  emailPassword: process.env.EMAIL_PASSWORD,

  // DB config
  DB_NAME: process.env.DB_NAME,
  DB_USER: process.env.DB_USER,
  DB_PASS: process.env.DB_PASS,
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT || 3306,

  // SMS & Face APIs
  SMS_API_KEY: process.env.SMS_API_KEY,
  SMS_API_URL: process.env.SMS_API_URL || "https://api.sms.net.bd/sendsms",
  MXFACE_KEY: process.env.MXFACE_KEY,
  MXFACE_API_URL: process.env.MXFACE_API_URL || "https://faceapi.mxface.ai/api/v3/face/",

  // Mock Service Resources
  RANDOM_USER_API_URL: process.env.RANDOM_USER_API_URL || "https://randomuser.me/api/portraits/",
  PLACEHOLD_JP_URL: process.env.PLACEHOLD_JP_URL || "https://placehold.jp/",

  // Storage config
  STORAGE_PROVIDER: process.env.STORAGE_PROVIDER || "s3",
  MINIO_ENDPOINT: process.env.MINIO_ENDPOINT || "http://openvidu-minio:9000",
  MINIO_BUCKET: process.env.MINIO_BUCKET || "vbrm",
  MINIO_PUBLIC_URL: process.env.MINIO_PUBLIC_URL,

  // DigitalOcean Spaces
  SPACES_BUCKET: process.env.SPACES_BUCKET,
  SPACES_KEY: process.env.SPACES_KEY,
  SPACES_SECRET: process.env.SPACES_SECRET,

  // AWS
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION || "us-east-1",

  // OpenCV Face Service
  OPENCV_SERVICE_URL: process.env.OPENCV_SERVICE_URL || "http://opencv-face-service:5097",

  // Redis
  REDIS_HOST: process.env.REDIS_HOST || "vbrm-redis",
  REDIS_PORT: process.env.REDIS_PORT || 6379,
  REDIS_PASSWORD: process.env.REDIS_PASSWORD,

  // CBS API (Production)
  CBS_API_KEY: process.env.CBS_API_KEY,
  CBS_API_URL: process.env.CBS_API_URL || "https://api.yourbank.com/v1",
};
