const { Router } = require("express");
const jwt = require("jsonwebtoken");
const { handleImageFileUpload, handleMultipleFileUpload, handleViewDocument } = require("../controllers/image.controller");
const multer = require("multer");
const { matchesMimeType } = require("../utils/fileSignature");
const { getTokenFromRequest } = require("../utils/cookieHelper");
const { jwtSecret } = require("../configs/variables");

const router = Router();

// Accepts either a manager or an admin/supervisor JWT — token via
// Authorization header or ?token= query param, since <img>/window.open
// requests can't attach headers (same pattern as recording.route.js).
const staffAuthMiddleware = (req, res, next) => {
  const token = getTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ success: false, message: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });
    const isManager = decoded.role === "manager";
    const isAdminStaff = decoded.type === "admin";
    if (!isManager && !isAdminStaff) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, message: "Token expired" });
    }
    return res.status(401).json({ success: false, message: "Invalid token" });
  }
};
const storage = multer.memoryStorage();

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_DOCUMENT_TYPES = [...ALLOWED_IMAGE_TYPES, 'application/pdf'];

const imageFilter = (req, file, cb) => {
  if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(Object.assign(new Error('Only JPEG, PNG, WebP, and GIF images are allowed'), { status: 400 }), false);
  }
};

const documentFilter = (req, file, cb) => {
  if (ALLOWED_DOCUMENT_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(Object.assign(new Error('Only images and PDF documents are allowed'), { status: 400 }), false);
  }
};

const uploadImage = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: imageFilter });
const uploadDocuments = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: documentFilter });

// Content-Type is client-supplied and trivially spoofable (an SVG declaring
// "image/png" passed the filter above and was later served inline, executing
// embedded <script> content) — verify the actual file bytes match the
// declared type before it reaches storage.
const verifyFileSignature = (req, res, next) => {
  const files = req.files || (req.file ? [req.file] : []);
  for (const file of files) {
    if (!matchesMimeType(file.buffer, file.mimetype)) {
      return res.status(400).json({
        success: false,
        message: 'File content does not match its declared type',
      });
    }
  }
  next();
};

/**
 * @swagger
 * tags:
 *   name: Image
 *   description: Image/document upload (face captures, verification documents)
 */

/**
 * @swagger
 * /image/upload:
 *   post:
 *     summary: Upload a single image file (face capture)
 *     tags: [Image]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       200: { description: File uploaded }
 *       400: { description: Invalid file type or content }
 */
// Single file upload (face capture — images only)
router.post("/upload", uploadImage.single("file"), verifyFileSignature, handleImageFileUpload);

/**
 * @swagger
 * /image/upload-multiple:
 *   post:
 *     summary: Upload up to 5 image/PDF documents (address verification)
 *     tags: [Image]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               files: { type: array, items: { type: string, format: binary } }
 *     responses:
 *       200: { description: Files uploaded }
 *       400: { description: Invalid file type or content }
 */
// Multiple file upload (address verification documents — images + PDF, up to 5 files)
router.post("/upload-multiple", uploadDocuments.array("files", 5), verifyFileSignature, handleMultipleFileUpload);

/**
 * @swagger
 * /image/view:
 *   get:
 *     summary: Stream a previously uploaded document/image via an authenticated proxy (token via header or ?token= query param)
 *     tags: [Image]
 *     parameters:
 *       - in: query
 *         name: path
 *         required: true
 *         schema: { type: string }
 *         description: The stored document path/URL (as returned by upload) — only the filename after "/uploads/" is used.
 *       - in: query
 *         name: token
 *         schema: { type: string }
 *     responses:
 *       200: { description: Document stream }
 *       400: { description: Missing/invalid path }
 *       401: { description: Missing/invalid token }
 *       403: { description: Manager or admin access required }
 *       404: { description: Not found }
 */
// View/verify a document (manager or admin) — proxies the file server-side so
// the browser never needs direct, unauthenticated access to the storage bucket.
router.get("/view", staffAuthMiddleware, handleViewDocument);

module.exports = router;
