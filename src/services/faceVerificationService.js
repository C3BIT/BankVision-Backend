/**
 * Face Verification Service
 *
 * Delegates face matching to CBS getUserIdentity API.
 * CBS stores the reference photo internally — only the captured image and account number are sent.
 */

const cbsService = require("./cbsService");

/**
 * Verify face by sending captured image to CBS for comparison.
 *
 * @param {string} accountNumber - Customer's bank account number
 * @param {string} capturedImage - Base64 or URL of captured face image
 * @returns {Promise<{verified: boolean, score: number, message: string}>}
 */
const verifyFaceViaCBS = async (accountNumber, capturedImage) => {
  if (!accountNumber) {
    return {
      verified: false,
      score: 0,
      message: "No account number available for face verification",
      noAccountNumber: true,
    };
  }

  console.log(`🔍 Sending face to CBS for account ${accountNumber}`);

  const result = await cbsService.getUserIdentity(accountNumber, capturedImage);

  console.log(`📊 CBS face result for ${accountNumber}: score=${result.score}, isMatch=${result.isMatch}`);

  return {
    verified: result.isMatch,
    score: result.score,
    message: result.isMatch
      ? "Face verification successful"
      : "Face does not match bank records",
  };
};

/**
 * Legacy alias kept so socketHandler.js call sites remain unchanged.
 */
const verifyFaceAgainstNID = async (customerPhone, capturedImage, nidData, accountNumber) => {
  return verifyFaceViaCBS(accountNumber || customerPhone, capturedImage);
};

const quickVerifyFace = async (customerPhone, capturedImage, accountNumber) => {
  return verifyFaceViaCBS(accountNumber || customerPhone, capturedImage);
};

module.exports = {
  verifyFaceViaCBS,
  verifyFaceAgainstNID,
  quickVerifyFace,
};
