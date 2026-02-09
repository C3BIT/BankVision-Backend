/**
 * Face Verification Service
 *
 * Compares captured face image with customer's CBS profile image
 * using the OpenCV face comparison service.
 */

const { compareFacesByOpenCV, checkOpenCVHealth } = require("./faceCompareService");
const { getCustomerImageByPhone } = require("./customerService");

const FACE_MATCH_THRESHOLD = 65; // Minimum score to consider a match

/**
 * Compare two face images using OpenCV service
 *
 * @param {string} capturedImage - URL or base64 of captured image
 * @param {string} referenceImage - URL or base64 of reference image (CBS profile)
 * @returns {Promise<{matched: boolean, score: number, confidence: number}>}
 */
const compareFaces = async (capturedImage, referenceImage) => {
  try {
    const result = await compareFacesByOpenCV(capturedImage, referenceImage);

    return {
      matched: result.matched,
      score: result.similarity,
      confidence: result.confidence,
      threshold: FACE_MATCH_THRESHOLD,
      facesDetected: result.facesDetected,
      processingTime: Date.now()
    };
  } catch (error) {
    console.error("Face comparison error:", error.message);
    throw error;
  }
};

/**
 * Verify face against customer's CBS profile image
 *
 * @param {string} customerPhone - Customer's phone number
 * @param {string} capturedImage - URL or base64 of captured face image
 * @param {object} nidData - Optional NID data (fallback reference)
 * @returns {Promise<{verified: boolean, score: number, details: object}>}
 */
const verifyFaceAgainstNID = async (customerPhone, capturedImage, nidData = null) => {
  try {
    console.log(`🔍 Starting face verification for customer ${customerPhone}`);

    // First try to get profile image from CBS
    const cbsImage = await getCustomerImageByPhone(customerPhone);

    let referenceImage = null;

    if (cbsImage && cbsImage.profileImage) {
      referenceImage = cbsImage.profileImage;
      console.log(`✅ Using CBS profile image for verification`);
    } else if (nidData && nidData.photo) {
      referenceImage = nidData.photo;
      console.log(`⚠️ CBS profile image not found, using NID photo`);
    }

    if (!referenceImage) {
      console.log(`⚠️ No reference image available for customer ${customerPhone}`);
      return {
        verified: false,
        score: 0,
        confidence: 0,
        message: 'No reference image available for verification',
        noReferenceImage: true
      };
    }

    // Compare faces using OpenCV
    const result = await compareFaces(capturedImage, referenceImage);

    const verified = result.matched;

    console.log(`📊 Face verification result for ${customerPhone}: score=${result.score}%, matched=${verified}`);

    return {
      verified,
      score: result.score,
      confidence: result.confidence,
      threshold: result.threshold,
      facesDetected: result.facesDetected,
      message: verified ? 'Face verification successful' : 'Face does not match reference photo'
    };
  } catch (error) {
    console.error(`❌ Face verification error for ${customerPhone}:`, error);
    throw new Error('Face verification failed: ' + error.message);
  }
};

/**
 * Quick verify face (basic check without reference comparison)
 *
 * @param {string} customerPhone - Customer's phone number
 * @param {string} capturedImage - URL or base64 of captured face image
 * @returns {Promise<{verified: boolean, score: number}>}
 */
const quickVerifyFace = async (customerPhone, capturedImage) => {
  try {
    console.log(`🔍 Quick face verification for customer ${customerPhone}`);

    // Try to get CBS profile image and do full comparison
    const cbsImage = await getCustomerImageByPhone(customerPhone);

    if (cbsImage && cbsImage.profileImage) {
      // Do full face comparison with CBS profile
      const result = await compareFaces(capturedImage, cbsImage.profileImage);

      return {
        verified: result.matched,
        score: result.score,
        confidence: result.confidence,
        message: result.matched ? 'Face verification successful' : 'Face does not match profile'
      };
    }

    // No CBS profile - just return that face was captured
    console.log(`⚠️ No CBS profile image for ${customerPhone}, face captured but not verified against reference`);

    return {
      verified: true, // Face was captured successfully
      score: 0,
      confidence: 0,
      message: 'Face captured (no reference image for comparison)',
      noReferenceImage: true
    };
  } catch (error) {
    console.error(`❌ Quick face verification error for ${customerPhone}:`, error);

    // If OpenCV service is down, return error
    return {
      verified: false,
      score: 0,
      message: 'Face verification service unavailable: ' + error.message,
      error: true
    };
  }
};

/**
 * Check if face verification service is available
 */
const checkServiceHealth = async () => {
  return await checkOpenCVHealth();
};

module.exports = {
  compareFaces,
  verifyFaceAgainstNID,
  quickVerifyFace,
  checkServiceHealth,
  FACE_MATCH_THRESHOLD
};
