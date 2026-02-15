const { errorResponseHandler } = require("../middlewares/errorResponseHandler");
const { statusCodes } = require("../utils/statusCodes");

/**
 * Mock Signature Verification Controller
 * Performs a mock similarity check between two signature images
 */
const verifySignatureController = async (req, res) => {
    try {
        const { signatureImagePath, customerPhone } = req.body;

        if (!signatureImagePath) {
            throw Object.assign(new Error("Signature image is missing"), {
                status: statusCodes.BAD_REQUEST,
                error: { code: 40030 },
            });
        }

        // Mock similarity calculation (70-95%)
        const mockSimilarity = 70 + Math.random() * 25;
        const mockConfidence = 80 + Math.random() * 15;
        const mockMatched = mockSimilarity >= 80;

        console.log(`[Signature] Verification for ${customerPhone}: similarity=${mockSimilarity.toFixed(2)}%, matched=${mockMatched}`);

        return res.success({
            matched: mockMatched,
            similarity: mockSimilarity,
            confidence: mockConfidence,
            provider: "mock"
        }, "Signature Verification Successful.");

    } catch (err) {
        errorResponseHandler(err, req, res);
    }
};

module.exports = {
    verifySignatureController,
};
