const path = require("path");
const crypto = require("crypto");
const fs = require("fs").promises;
const { v4: uuidv4 } = require("uuid");

// MinIO Configuration
const BUCKET_NAME = process.env.MINIO_BUCKET || "vbrm";
const MINIO_PUBLIC_URL = process.env.MINIO_PUBLIC_URL || "https://minio.ucchash4vc.xyz";
const STORAGE_PROVIDER = process.env.STORAGE_PROVIDER || "s3";

console.log('🗄️ Storage Configuration:', {
  provider: STORAGE_PROVIDER,
  bucket: BUCKET_NAME,
  publicUrl: MINIO_PUBLIC_URL
});

const imageFileUpload = async (file) => {
  try {
    const fileName = `${crypto.randomBytes(8).toString("hex")}-${uuidv4()}${path.extname(file.originalname)}`;
    const key = `uploads/${fileName}`;

    if (STORAGE_PROVIDER === "local") {
      const uploadDir = path.join(__dirname, "../../uploads");
      const filePath = path.join(uploadDir, fileName);

      console.log('📂 Storing file locally:', {
        fileName: file.originalname,
        size: file.size,
        path: filePath
      });

      await fs.writeFile(filePath, file.buffer);
      const fileUrl = `${MINIO_PUBLIC_URL}/uploads/${fileName}`;
      console.log('✅ File stored locally successfully:', fileUrl);
      return fileUrl;
    }

    // Default to S3/MinIO
    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    const s3Client = require("../configs/s3Client");

    console.log('📤 Uploading file to MinIO:', {
      fileName: file.originalname,
      size: file.size,
      bucket: BUCKET_NAME,
      key: key
    });

    const params = {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    };

    const command = new PutObjectCommand(params);
    await s3Client.send(command).catch(err => {
      // Re-throw with more context
      if (err.name === 'Forbidden' || err.$metadata?.httpStatusCode === 403) {
        console.error("❌ S3 Forbidden error. Tip: Try setting STORAGE_PROVIDER=local in .env");
      }
      throw err;
    });

    const fileUrl = `${MINIO_PUBLIC_URL}/${BUCKET_NAME}/${key}`;
    console.log('✅ File uploaded successfully to MinIO:', fileUrl);
    return fileUrl;
  } catch (error) {
    console.error("❌ Error processing file upload:", error);
    throw new Error("File upload failed: " + error.message);
  }
};

module.exports = { imageFileUpload };
