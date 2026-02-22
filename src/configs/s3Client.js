const { S3Client } = require("@aws-sdk/client-s3");
const { MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_USE_SSL: USE_SSL_VAR } = require("./variables");

// MinIO Configuration
const MINIO_USE_SSL = USE_SSL_VAR === "true";

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
