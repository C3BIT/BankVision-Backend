const { PutObjectCommand } = require("@aws-sdk/client-s3");
const s3Client = require("../configs/s3Client");
const path = require("path");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

// MinIO Configuration
const BUCKET_NAME = process.env.MINIO_BUCKET || "vbrm";
const MINIO_PUBLIC_URL = process.env.MINIO_PUBLIC_URL || "https://minio.ucchash4vc.xyz";

console.log('🗄️ MinIO Storage Configuration:', {
  bucket: BUCKET_NAME,
  publicUrl: MINIO_PUBLIC_URL
});

const imageFileUpload = async (file) => {
  try {
    const fileName = `${crypto.randomBytes(8).toString("hex")}-${uuidv4()}${path.extname(file.originalname)}`;
    const key = `uploads/${fileName}`;

    console.log('📤 Uploading file to MinIO:', {
      fileName: file.originalname,
      size: file.size,
      type: file.mimetype,
      bucket: BUCKET_NAME,
      key: key
    });

    const params = {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      // MinIO doesn't use ACL the same way, files are public based on bucket policy
    };

    const command = new PutObjectCommand(params);
    await s3Client.send(command);

    const fileUrl = `${MINIO_PUBLIC_URL}/${BUCKET_NAME}/${key}`;

    console.log('✅ File uploaded successfully to MinIO:', fileUrl);

    return fileUrl;
  } catch (error) {
    console.error("❌ Error uploading file to MinIO:", error);
    throw new Error("File upload failed: " + error.message);
  }
};

module.exports = { imageFileUpload };
