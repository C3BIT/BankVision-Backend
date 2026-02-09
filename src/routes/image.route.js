const { Router } = require("express");
const { handleImageFileUpload, handleMultipleFileUpload } = require("../controllers/image.controller");
const multer = require("multer");

const router = Router();
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
  },
});

// Single file upload
router.post("/upload", upload.single("file"), handleImageFileUpload);

// Multiple file upload (up to 5 files)
router.post("/upload-multiple", upload.array("files", 5), handleMultipleFileUpload);

module.exports = router;
