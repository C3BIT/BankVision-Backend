const axios = require("axios");
const https = require("https");
const { MXFACE_KEY, OPENCV_SERVICE_URL } = require("../configs/variables");
const rekognition = require("../configs/rekognition");

// MXFace API (legacy)
const API_URL = "https://faceapi.mxface.ai/api/v3/face/";
const SUBSCRIPTION_KEY = MXFACE_KEY;

// OpenCV Service URL (default to local Docker)
const OPENCV_URL = OPENCV_SERVICE_URL || "http://localhost:5097";

const fs = require("fs").promises;
const path = require("path");

// Helper to determine if a URL is local and return the absolute file path
const getLocalFilePath = (url) => {
  const MINIO_PUBLIC_URL = process.env.MINIO_PUBLIC_URL || "";
  // Check if URL starts with our public URL
  if (url && MINIO_PUBLIC_URL && url.startsWith(MINIO_PUBLIC_URL)) {
    const filename = url.split("/").pop();
    if (filename) {
      return path.resolve(__dirname, "../../uploads", filename);
    }
  }
  return null;
};

const encodeImageToBase64FromUrl = async (imageUrl) => {
  try {
    // Optimization: Read directly from disk if local
    const localPath = getLocalFilePath(imageUrl);
    if (localPath) {
      const buffer = await fs.readFile(localPath);
      return buffer.toString("base64");
    }

    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 15000, // 15s timeout
    });
    return Buffer.from(response.data, "binary").toString("base64");
  } catch (error) {
    console.error(`❌ Failed to fetch image for encoding: ${imageUrl}`, error.message);
    throw new Error(`Could not fetch image for face verification: ${imageUrl}. Error: ${error.message}`);
  }
};

const impageBufferFromUrl = async (imageUrl) => {
  try {
    // Optimization: Read directly from disk if local
    const localPath = getLocalFilePath(imageUrl);
    if (localPath) {
      return await fs.readFile(localPath);
    }

    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 15000,
    });
    return response.data;
  } catch (error) {
    console.error(`❌ Failed to fetch image buffer: ${imageUrl}`, error.message);
    throw new Error(`Could not download image buffer: ${imageUrl}. Error: ${error.message}`);
  }
};

/**
 * Compare faces using MXFace API (legacy)
 */
const compareFaces = async (imagePath1, imagePath2) => {
  const encodedImage1 = await encodeImageToBase64FromUrl(imagePath1);
  const encodedImage2 = await encodeImageToBase64FromUrl(imagePath2);

  const options = {
    method: "POST",
    url: `${API_URL}verify`,
    headers: {
      subscriptionkey: SUBSCRIPTION_KEY,
      "Content-Type": "application/json",
    },
    data: {
      encoded_image1: encodedImage1,
      encoded_image2: encodedImage2,
    },
    httpsAgent: new (require("https").Agent)({ rejectUnauthorized: false }),
  };
  const response = await axios(options);
  return response.data;
};

/**
 * Compare faces using AWS Rekognition
 */
const compareFacesAsync = (params) => {
  return new Promise((resolve, reject) => {
    rekognition.compareFaces(params, (err, response) => {
      if (err) return reject(err);
      resolve(response);
    });
  });
};

const compareFacesByAWS = async (imagePath1, imagePath2) => {
  const encodedImage1 = await impageBufferFromUrl(imagePath1);
  const encodedImage2 = await impageBufferFromUrl(imagePath2);
  const params = {
    SourceImage: {
      Bytes: encodedImage1,
    },
    TargetImage: {
      Bytes: encodedImage2,
    },
    SimilarityThreshold: 50,
  };
  const response = await compareFacesAsync(params);
  return response;
};

/**
 * Compare faces using local OpenCV service
 * @param {string} imagePath1 - URL or base64 of first image
 * @param {string} imagePath2 - URL or base64 of second image
 * @returns {Promise<{matched: boolean, similarity: number, confidence: number}>}
 */
const compareFacesByOpenCV = async (imagePath1, imagePath2) => {
  try {
    console.log(`[OpenCV] Processing face comparison...`);

    // CRITICAL OPTIMIZATION: Convert to base64 in Backend
    // This removes the dependency on the Face Service needing to "download" from the Backend URL.
    const encodedImage1 = await encodeImageToBase64FromUrl(imagePath1);
    const encodedImage2 = await encodeImageToBase64FromUrl(imagePath2);

    console.log(`[OpenCV] Images encoded successfully. Sending to service: ${OPENCV_URL}`);

    const response = await axios.post(
      `${OPENCV_URL}/compare`,
      {
        image1: encodedImage1,
        image2: encodedImage2,
      },
      {
        timeout: 45000, // Increased timeout for heavy processing
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const result = response.data;

    console.log(`[OpenCV] Result: similarity=${result.similarity}%, matched=${result.matched}`);

    return {
      matched: result.matched,
      similarity: result.similarity,
      confidence: result.confidence,
      facesDetected: result.faces_detected,
      message: result.message,
    };
  } catch (error) {
    console.error(`[OpenCV] Face comparison error:`, error.message);

    // If OpenCV service is unavailable, return error
    if (error.code === "ECONNREFUSED") {
      throw new Error(`OpenCV face service is unreachable at ${OPENCV_URL}. Verify it is deployed and on the same network.`);
    }

    throw error;
  }
};

/**
 * Check if OpenCV service is healthy
 */
const checkOpenCVHealth = async () => {
  try {
    const response = await axios.get(`${OPENCV_URL}/health`, { timeout: 5000 });
    return {
      healthy: true,
      ...response.data,
    };
  } catch (error) {
    return {
      healthy: false,
      error: error.message,
    };
  }
};

module.exports = {
  compareFaces,
  compareFacesByAWS,
  compareFacesByOpenCV,
  checkOpenCVHealth,
};
