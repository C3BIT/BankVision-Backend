const { errorResponseHandler } = require("../middlewares/errorResponseHandler");
const {
  compareFaces,
  compareFacesByAWS,
  compareFacesByOpenCV,
  compareFacesByCBS,
  checkOpenCVHealth,
} = require("../services/faceCompareService");
const { statusCodes } = require("../utils/statusCodes");

const getActiveProvider = () => process.env.FACE_PROVIDER || "opencv";

const compareFacesController = async (req, res) => {
  try {
    const { imagePath1, imagePath2, accountNo } = req.body;
    const FACE_PROVIDER = getActiveProvider();

    // CBS only needs the captured image + account number (reference photo is in the bank)
    if (FACE_PROVIDER !== "cbs" && (!imagePath1 || !imagePath2)) {
      throw Object.assign(new Error("Image File is Missing"), {
        status: statusCodes.BAD_REQUEST,
        error: { code: 40030 },
      });
    }

    let result;

    switch (FACE_PROVIDER) {
      case "cbs": {
        if (!imagePath2 || !accountNo) {
          throw Object.assign(new Error("imagePath2 and accountNo are required for CBS face verification"), {
            status: statusCodes.BAD_REQUEST,
            error: { code: 40031 },
          });
        }
        result = await compareFacesByCBS(accountNo, imagePath2);
        return res.success({
          imageMatched: result.matched,
          similarity: result.similarity,
          confidence: result.confidence,
          provider: "cbs",
        }, "Face Verification Successful (CBS).");
      }

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

      default:
        result = await compareFacesByOpenCV(imagePath1, imagePath2);
        return res.success({
          imageMatched: result.matched,
          similarity: result.similarity,
          confidence: result.confidence,
          provider: "opencv",
        }, "Face Comparison Successful (OpenCV).");
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

    const activeProvider = getActiveProvider();

    // CBS provider
    if (activeProvider === "cbs") {
      const { imagePath2, accountNo } = req.body;
      if (!imagePath2 || !accountNo) {
        throw Object.assign(new Error("imagePath2 and accountNo are required for CBS face verification"), {
          status: statusCodes.BAD_REQUEST,
          error: { code: 40031 },
        });
      }
      const cbsResult = await compareFacesByCBS(accountNo, imagePath2);
      return res.success({
        imageMatched: cbsResult.matched,
        similarity: cbsResult.similarity,
        confidence: cbsResult.confidence,
        provider: "cbs",
      }, "Face Verification Successful (CBS).");
    }

    // Use OpenCV by default now
    if (activeProvider === "opencv") {
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
    const activeProvider = getActiveProvider();
    const health = await checkOpenCVHealth();
    res.success({
      provider: activeProvider,
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
