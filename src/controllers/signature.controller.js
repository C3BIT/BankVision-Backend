const axios = require("axios");
const { errorResponseHandler } = require("../middlewares/errorResponseHandler");
const { statusCodes } = require("../utils/statusCodes");
const { OPENCV_SERVICE_URL, MINIO_PUBLIC_URL, MINIO_BUCKET } = require("../configs/variables");
const cbsService = require("../services/cbsRealService");

// Fetch image as base64 — resolves MinIO URLs via SDK to avoid public URL routing issues
const fetchImageAsBase64 = async (imagePath) => {
    if (!imagePath) return null;
    if (imagePath.startsWith("data:image/")) return imagePath;

    const minioPublic = (MINIO_PUBLIC_URL || "").replace(/\/$/, "");
    if (minioPublic && imagePath.startsWith(minioPublic)) {
        const objectPath = imagePath.slice(minioPublic.length).replace(/^\//, "");
        const slashIdx = objectPath.indexOf("/");
        const bucket = slashIdx > -1 ? objectPath.slice(0, slashIdx) : (MINIO_BUCKET || "vbrm");
        const key = slashIdx > -1 ? objectPath.slice(slashIdx + 1) : objectPath;
        const { GetObjectCommand } = require("@aws-sdk/client-s3");
        const s3Client = require("../configs/s3Client");
        const s3Res = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const chunks = [];
        for await (const chunk of s3Res.Body) chunks.push(chunk);
        const ext = key.split(".").pop().toLowerCase();
        const mime = ext === "png" ? "image/png" : "image/jpeg";
        return `data:${mime};base64,${Buffer.concat(chunks).toString("base64")}`;
    }

    // Already a data URI or external URL — return as-is
    return imagePath;
};

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

        // Resolve captured signature to base64 (MinIO URL → SDK fetch)
        const capturedImage = await fetchImageAsBase64(signatureImagePath);

        // Compare captured signature against CBS reference via OpenCV SSIM
        const opencvRes = await axios.post(
            `${OPENCV_SERVICE_URL}/compare-images`,
            {
                image1: `data:image/jpeg;base64,${referenceBase64}`,
                image2: capturedImage,
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
