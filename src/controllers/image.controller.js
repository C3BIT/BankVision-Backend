const path = require("path");
const fs = require("fs");
const { errorResponseHandler } = require("../middlewares/errorResponseHandler");
const { imageFileUpload } = require("../services/spaceService");
const { statusCodes } = require("../utils/statusCodes");

const handleImageFileUpload = async (req, res) => {
  try {
    if (!req.file) {
      throw Object.assign(new Error(), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40030 },
      });
    }
    const imagePath = await imageFileUpload(req.file);
    res.success({ imagePath }, "Image Uploaded Successfully.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

// Handle multiple file uploads (for address verification documents)
const handleMultipleFileUpload = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      throw Object.assign(new Error("No files uploaded"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40030 },
      });
    }

    const uploadPromises = req.files.map(file => imageFileUpload(file));
    const uploadedPaths = await Promise.all(uploadPromises);

    const files = req.files.map((file, index) => ({
      name: file.originalname,
      path: uploadedPaths[index],
      size: file.size,
      type: file.mimetype
    }));

    res.success({ files }, "Files Uploaded Successfully.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

// Streams a previously-uploaded document/image back through an authenticated
// backend proxy instead of the raw stored URL. The MinIO bucket has no
// public-read policy (and the app's scoped access key can't grant one), so
// direct browser requests to stored URLs 403. Deriving the object key from
// whatever comes after "/uploads/" also self-heals records that baked in a
// stale MINIO_PUBLIC_URL host from a past misconfiguration.
const handleViewDocument = async (req, res) => {
  try {
    const rawPath = req.query.path;
    if (!rawPath || typeof rawPath !== "string") {
      return res.status(400).json({ success: false, message: "path query parameter is required" });
    }

    const marker = "/uploads/";
    const markerIndex = rawPath.indexOf(marker);
    if (markerIndex === -1) {
      return res.status(400).json({ success: false, message: "Invalid document path" });
    }

    const fileName = rawPath.substring(markerIndex + marker.length).split(/[?#]/)[0];
    if (!fileName || fileName.includes("/") || fileName.includes("..")) {
      return res.status(400).json({ success: false, message: "Invalid document path" });
    }

    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    res.setHeader("Cache-Control", "private, max-age=300");
    // The manager panel serves COEP: require-corp, so a cross-origin <img>
    // load of this endpoint is blocked unless the response opts in via CORP.
    // Still gated by staffAuthMiddleware above, so this only widens who may
    // embed an already-authorized response, not who may fetch it.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

    if (process.env.STORAGE_PROVIDER === "local") {
      const uploadDir = path.resolve(__dirname, "../../uploads");
      const filePath = path.join(uploadDir, fileName);

      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        return res.status(404).json({ success: false, message: "Document not found" });
      }

      res.setHeader("Content-Length", stat.size);
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const { GetObjectCommand } = require("@aws-sdk/client-s3");
    const s3Client = require("../configs/s3Client");
    const bucket = process.env.MINIO_BUCKET || "vbrm";

    let result;
    try {
      result = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: `uploads/${fileName}` }));
    } catch (s3Error) {
      if (s3Error.name === "NoSuchKey" || s3Error.$metadata?.httpStatusCode === 404) {
        return res.status(404).json({ success: false, message: "Document not found" });
      }
      throw s3Error;
    }

    if (result.ContentType) res.setHeader("Content-Type", result.ContentType);
    if (result.ContentLength) res.setHeader("Content-Length", result.ContentLength);
    result.Body.pipe(res);
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

module.exports = {
  handleImageFileUpload,
  handleMultipleFileUpload,
  handleViewDocument,
};
