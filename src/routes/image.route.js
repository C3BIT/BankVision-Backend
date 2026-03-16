const { Router } = require("express");
const { handleImageFileUpload, handleMultipleFileUpload } = require("../controllers/image.controller");
const multer = require("multer");

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

// Single file upload (face capture — images only)
router.post("/upload", uploadImage.single("file"), handleImageFileUpload);

// Multiple file upload (address verification documents — images + PDF, up to 5 files)
router.post("/upload-multiple", uploadDocuments.array("files", 5), handleMultipleFileUpload);

module.exports = router;
