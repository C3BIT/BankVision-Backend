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
      originalName: file.originalname,
      path: uploadedPaths[index],
      size: file.size,
      mimeType: file.mimetype
    }));

    res.success({ files }, "Files Uploaded Successfully.");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

module.exports = {
  handleImageFileUpload,
  handleMultipleFileUpload,
};
