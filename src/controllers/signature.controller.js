const axios = require("axios");
const { errorResponseHandler } = require("../middlewares/errorResponseHandler");
const { statusCodes } = require("../utils/statusCodes");
const { OPENCV_SERVICE_URL } = require("../configs/variables");
const cbsService = require("../services/cbsRealService");

const verifySignatureController = async (req, res) => {
    try {
        const { signatureImagePath, customerPhone, accountNumber } = req.body;

        if (!signatureImagePath) {
            throw Object.assign(new Error("Signature image is required"), {
                status: statusCodes.BAD_REQUEST,
                error: { code: 40030 },
            });
        }

        // Resolve account number from phone if not provided
        let accNo = accountNumber;
        if (!accNo && customerPhone) {
            const accounts = await cbsService.getAccountsByPhone(customerPhone);
            if (accounts && accounts.length > 0) {
                accNo = accounts[0].accountNumber;
            }
        }

        if (!accNo) {
            throw Object.assign(new Error("Account number required for signature verification"), {
                status: statusCodes.BAD_REQUEST,
                error: { code: 40031 },
            });
        }

        // Fetch stored signature from CBS
        const referenceBase64 = await cbsService.getCustomerSignature(accNo);

        if (!referenceBase64) {
            throw Object.assign(new Error("Could not retrieve reference signature from CBS"), {
                status: statusCodes.SERVICE_UNAVAILABLE || 503,
                error: { code: 50301 },
            });
        }

        // Compare captured signature against CBS reference via OpenCV SSIM
        const opencvRes = await axios.post(
            `${OPENCV_SERVICE_URL}/compare-images`,
            {
                image1: `data:image/jpeg;base64,${referenceBase64}`,
                image2: signatureImagePath.startsWith("http") ? signatureImagePath : signatureImagePath,
            },
            { timeout: 15000 }
        );

        const { matched, similarity, ssim_score } = opencvRes.data;

        console.log(`[Signature] ${accNo}: similarity=${similarity.toFixed(2)}%, matched=${matched}`);

        return res.success({
            matched,
            similarity,
            confidence: similarity,
            ssim_score,
            provider: "opencv-ssim",
        }, "Signature Verification Successful.");

    } catch (err) {
        errorResponseHandler(err, req, res);
    }
};

module.exports = {
    verifySignatureController,
};
