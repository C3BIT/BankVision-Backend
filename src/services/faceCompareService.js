const axios = require("axios");
const https = require("https");
const { MXFACE_KEY, OPENCV_SERVICE_URL } = require("../configs/variables");
const rekognition = require("../configs/rekognition");

// MXFace API (legacy)
const API_URL = "https://faceapi.mxface.ai/api/v3/face/";
const SUBSCRIPTION_KEY = MXFACE_KEY;

// OpenCV Service URL (default to local Docker)
const OPENCV_URL = OPENCV_SERVICE_URL || "http://localhost:5097";

const encodeImageToBase64FromUrl = async (imageUrl) => {
  try {
    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 10000, // 10s timeout for image download
    });
    return Buffer.from(response.data, "binary").toString("base64");
  } catch (error) {
    console.error(`❌ Failed to fetch image for encoding: ${imageUrl}`, error.message);
    throw new Error(`Could not fetch image for face verification: ${imageUrl}. Error: ${error.message}`);
  }
};

const impageBufferFromUrl = async (imageUrl) => {
  try {
    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 10000,
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
    console.log(`[OpenCV] Comparing faces...`);
    console.log(`  - Image 1: ${imagePath1.substring(0, 60)}...`);
    console.log(`  - Image 2: ${imagePath2.substring(0, 60)}...`);

    const response = await axios.post(
      `${OPENCV_URL}/compare`,
      {
        image1: imagePath1,
        image2: imagePath2,
      },
      {
        timeout: 30000, // 30 second timeout
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
      throw new Error("OpenCV face service is not running. Please start the Docker container.");
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
