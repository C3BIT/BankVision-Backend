const axios = require("axios");
const https = require("https");
const { MXFACE_KEY, OPENCV_SERVICE_URL, MXFACE_API_URL, CBS_CORE_URL, CBS_CHANNEL_ID, MINIO_ENDPOINT, MINIO_PUBLIC_URL: MINIO_PUB, MINIO_BUCKET } = require("../configs/variables");
// Docker-internal services (MinIO, OpenCV, MXFace) use self-signed certs in all environments
const internalHttpsAgent = new https.Agent({ rejectUnauthorized: false });
const rekognition = require("../configs/rekognition");

// MXFace API (legacy)
const API_URL = MXFACE_API_URL || "https://faceapi.mxface.ai/api/v3/face/";
const SUBSCRIPTION_KEY = MXFACE_KEY;

// OpenCV Service URL (default to local Docker)
const OPENCV_URL = OPENCV_SERVICE_URL || "http://opencv-face-service:5097";

const fs = require("fs").promises;
const path = require("path");

// Helper to determine if a URL is local and return the absolute file path
const getLocalFilePath = (url) => {
  if (!url) return null;

  const MINIO_PUBLIC_URL = process.env.MINIO_PUBLIC_URL || "";

  // 1. Check if URL starts with our public URL (Standard Case)
  if (MINIO_PUBLIC_URL && url.startsWith(MINIO_PUBLIC_URL)) {
    // Extract everything after our public URL
    const relativePart = url.replace(MINIO_PUBLIC_URL, "");
    // Remove leading slash if any before joining
    const cleanRelativePath = relativePart.startsWith('/') ? relativePart.slice(1) : relativePart;

    // If it's just 'uploads/filename', resolve it
    if (cleanRelativePath.startsWith('uploads/')) {
      return path.resolve(__dirname, "../../", cleanRelativePath);
    }
  }

  return null;
};

const encodeImageToBase64FromUrl = async (imageUrl) => {
  try {
    // Already base64: data URI or raw base64 JPEG/PNG
    if (imageUrl.startsWith("data:image/")) {
      return imageUrl.split(",")[1];
    }
    if (/^[A-Za-z0-9+/]{100,}={0,2}$/.test(imageUrl.slice(0, 200))) {
      return imageUrl;
    }

    // Optimization: Read directly from disk if local
    const localPath = getLocalFilePath(imageUrl);
    if (localPath) {
      try {
        const buffer = await fs.readFile(localPath);
        return buffer.toString("base64");
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
        // File not on disk — fall through to HTTP fetch below
        console.warn(`⚠️ Local path not found (${localPath}), fetching via HTTP`);
      }
    }

    // Fetch from MinIO using SDK credentials when URL matches MINIO_PUBLIC_URL
    const minioPublic = (MINIO_PUB || process.env.MINIO_PUBLIC_URL || "").replace(/\/$/, "");
    if (minioPublic && imageUrl.startsWith(minioPublic)) {
      const objectPath = imageUrl.slice(minioPublic.length).replace(/^\//, "");
      const slashIdx = objectPath.indexOf("/");
      const bucket = slashIdx > -1 ? objectPath.slice(0, slashIdx) : (MINIO_BUCKET || process.env.MINIO_BUCKET || "vbrm");
      const key = slashIdx > -1 ? objectPath.slice(slashIdx + 1) : objectPath;
      console.log(`🗄️ Fetching from MinIO: bucket=${bucket} key=${key}`);
      const { GetObjectCommand } = require("@aws-sdk/client-s3");
      const s3Client = require("../configs/s3Client");
      const s3Res = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const chunks = [];
      for await (const chunk of s3Res.Body) chunks.push(chunk);
      return Buffer.concat(chunks).toString("base64");
    }

    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      httpsAgent: internalHttpsAgent,
      timeout: 15000,
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
      httpsAgent: internalHttpsAgent,
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
    httpsAgent: internalHttpsAgent,
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
        timeout: 15000, // 15s is sufficient for local OpenCV service
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const result = response.data;

    if (result == null || typeof result.matched !== 'boolean') {
      throw new Error(`Face Service returned unexpected response: ${JSON.stringify(result)}`);
    }

    console.log(`[OpenCV] Result: similarity=${result.similarity}%, matched=${result.matched}`);

    return {
      matched: result.matched,
      similarity: result.similarity ?? 0,
      confidence: result.confidence ?? 0,
      facesDetected: result.faces_detected ?? 0,
      message: result.message ?? '',
    };
  } catch (error) {
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      const status = error.response.status;
      const data = error.response.data;
      console.error(`[OpenCV] Face Service returned error ${status}:`, data);
      throw new Error(`Face Service Error (${status}): ${data.detail || JSON.stringify(data)}`);
    } else if (error.request) {
      // The request was made but no response was received
      console.error(`[OpenCV] No response from Face Service at ${OPENCV_URL}:`, error.message);
      if (error.code === "ECONNREFUSED") {
        throw new Error(`Face Service is unreachable at ${OPENCV_URL}. Verify the service name and network in Coolify.`);
      }
      throw new Error(`Face Service Timeout or Network Error: ${error.message}`);
    } else {
      // Something happened in setting up the request that triggered an Error
      console.error(`[OpenCV] Error setting up comparison request:`, error.message);
      throw error;
    }
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
      targetUrl: OPENCV_URL,
      tip: "Ensure OPENCV_SERVICE_URL is set to the correct FQDN or service name in Coolify."
    };
  }
};

/**
 * Compare face using MTB CBS getUserIdentity
 * Bank holds the reference photo — we only send the live capture + accountNo
 */
const compareFacesByCBS = async (accountNo, capturedImagePath) => {
  const imageBase64 = await encodeImageToBase64FromUrl(capturedImagePath);
  const response = await axios.post(
    `${CBS_CORE_URL}/coreMiddleware/cbs/getUserIdentity`,
    {
      accountNo,
      imageBase64,
      channelId: CBS_CHANNEL_ID || "101",
      refNo: `BV${Date.now().toString().slice(-8)}`,
    },
    { timeout: 15000 }
  );

  const data = response.data;
  if (data.resCode !== "000") throw new Error(data.resMsg || "CBS face verification failed");

  const score = parseFloat(data.data?.score ?? 0);
  const isMatch = data.data?.isMatch === "1";

  return {
    matched: isMatch,
    similarity: score,
    confidence: score,
    provider: "cbs",
  };
};

module.exports = {
  compareFaces,
  compareFacesByAWS,
  compareFacesByOpenCV,
  compareFacesByCBS,
  checkOpenCVHealth,
};
