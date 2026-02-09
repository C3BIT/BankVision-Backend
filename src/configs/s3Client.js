const { S3Client } = require("@aws-sdk/client-s3");
const dotenv = require("dotenv");

dotenv.config();

// MinIO Configuration
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "http://openvidu-minio:9000";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "vbrm_minio_key";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || "VbrmMinIO2024SecureKey";
const MINIO_USE_SSL = process.env.MINIO_USE_SSL === "true";

console.log('🗄️ Configuring S3 Client for MinIO:', {
  endpoint: MINIO_ENDPOINT,
  useSSL: MINIO_USE_SSL,
  accessKey: MINIO_ACCESS_KEY ? '***' + MINIO_ACCESS_KEY.slice(-4) : 'NOT SET'
});

const s3Client = new S3Client({
  forcePathStyle: true, // Required for MinIO
  endpoint: MINIO_ENDPOINT,
  region: "us-east-1", // MinIO doesn't care about region, but SDK requires it
  credentials: {
    accessKeyId: MINIO_ACCESS_KEY,
    secretAccessKey: MINIO_SECRET_KEY,
  },
});

module.exports = s3Client;
