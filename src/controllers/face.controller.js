const { errorResponseHandler } = require("../middlewares/errorResponseHandler");
const {
  compareFaces,
  compareFacesByAWS,
  compareFacesByOpenCV,
  checkOpenCVHealth,
} = require("../services/faceCompareService");
const { statusCodes } = require("../utils/statusCodes");

// Face comparison provider: 'opencv' | 'aws' | 'mxface' | 'mock'
const FACE_PROVIDER = process.env.FACE_PROVIDER || "opencv";

const compareFacesController = async (req, res) => {
  try {
    const { imagePath1, imagePath2 } = req.body;
    if (!imagePath1 || !imagePath2) {
      throw Object.assign(new Error("Image File is Missing"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40030 },
      });
    }

    let result;

    switch (FACE_PROVIDER) {
      case "opencv":
        // Use local OpenCV service
        result = await compareFacesByOpenCV(imagePath1, imagePath2);
        return res.success({
          imageMatched: result.matched,
          similarity: result.similarity,
          confidence: result.confidence,
          provider: "opencv"
        }, "Face Comparison Successful (OpenCV).");

      case "aws":
        // Use AWS Rekognition
        const awsResponse = await compareFacesByAWS(imagePath1, imagePath2);
        let awsOutput = { imageMatched: false, similarity: 0, confidence: 0 };

        if (awsResponse?.FaceMatches?.[0]) {
          const match = awsResponse.FaceMatches[0];
          awsOutput = {
            imageMatched: true,
            similarity: match.Similarity ?? 0,
            confidence: match.Face?.Confidence ?? 0,
          };
        }
        if (awsResponse?.UnmatchedFaces?.[0]) {
          const unmatched = awsResponse.UnmatchedFaces[0];
          awsOutput = {
            imageMatched: false,
            similarity: 0,
            confidence: unmatched.Confidence ?? 0,
          };
        }
        return res.success({ ...awsOutput, provider: "aws" }, "Face Comparison Done (AWS)!");

      case "mxface":
        // Use MXFace API
        const mxResult = await compareFaces(imagePath1, imagePath2);
        if (mxResult?.errorCode === 400 && mxResult?.errorMessage?.includes("No face detected")) {
          return res.success({ imageMatched: false, provider: "mxface" }, "Face Comparison Successful.");
        }
        const imageMatched = mxResult?.matchedFaces[0]?.matchResult === 1;
        return res.success({ imageMatched, provider: "mxface" }, "Face Comparison Successful.");

      case "mock":
      default:
        // Mock mode for testing
        const mockSimilarity = 75 + Math.random() * 20;
        const mockMatched = mockSimilarity >= 80;
        console.log(`[MOCK] Face comparison: similarity=${mockSimilarity.toFixed(2)}%, matched=${mockMatched}`);
        return res.success({
          imageMatched: mockMatched,
          similarity: mockSimilarity,
          provider: "mock"
        }, "Face Comparison Successful (Mock).");
    }
  } catch (err) {
    errorResponseHandler(err, req, res);
  }
};

const compareFacesByAWSController = async (req, res) => {
  try {
    const { imagePath1, imagePath2 } = req.body;
    if (!imagePath1 || !imagePath2) {
      throw Object.assign(new Error("Image File is Missing"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40030 },
      });
    }

    // Use OpenCV by default now
    if (FACE_PROVIDER === "opencv") {
      const result = await compareFacesByOpenCV(imagePath1, imagePath2);
      return res.success({
        imageMatched: result.matched,
        similarity: result.similarity,
        confidence: result.confidence,
        facesDetected: result.facesDetected,
        provider: "opencv"
      }, "Face Comparison Done (OpenCV)!");
    }

    // Fallback to AWS
    const response = await compareFacesByAWS(imagePath1, imagePath2);
    let output = {};
    if (response?.FaceMatches?.[0]) {
      const match = response.FaceMatches[0];
      output = {
        imageMatched: true,
        similarity: match.Similarity ?? 0,
        confidence: match.Face?.Confidence ?? 0,
      };
    }
    if (response?.UnmatchedFaces?.[0]) {
      const unmatched = response.UnmatchedFaces[0];
      output = {
        imageMatched: false,
        similarity: 0,
        confidence: unmatched.Confidence ?? 0,
      };
    }
    res.success({ ...output, provider: "aws" }, "Face Comparison Done!");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

/**
 * Health check for face comparison service
 */
const faceServiceHealthController = async (req, res) => {
  try {
    const health = await checkOpenCVHealth();
    res.success({
      provider: FACE_PROVIDER,
      opencv: health,
    }, "Face service health check");
  } catch (error) {
    errorResponseHandler(error, req, res);
  }
};

module.exports = {
  compareFacesController,
  compareFacesByAWSController,
  faceServiceHealthController,
};
