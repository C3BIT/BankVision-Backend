const { Router } = require("express");
const { handleImageFileUpload, handleMultipleFileUpload } = require("../controllers/image.controller");
const multer = require("multer");
const { matchesMimeType } = require("../utils/fileSignature");

const router = Router();
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

// Single file upload (face capture — images only)
router.post("/upload", uploadImage.single("file"), verifyFileSignature, handleImageFileUpload);

// Multiple file upload (address verification documents — images + PDF, up to 5 files)
router.post("/upload-multiple", uploadDocuments.array("files", 5), verifyFileSignature, handleMultipleFileUpload);

module.exports = router;
