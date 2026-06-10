const axios = require("axios");
const crypto = require("crypto");
const { OPENCV_SERVICE_URL } = require("../configs/variables");
const cbsService = require("../services/cbsRealService");

// In-memory sessions (same TTL pattern as mock)
const pendingVerifications = new Map();

const generateVerificationId = () =>
    `NID_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

const validateNIDFormat = (nidNumber) => {
    const cleaned = nidNumber.replace(/\D/g, "");
    return cleaned.length === 10 || cleaned.length === 17;
};

setInterval(() => {
    const now = Date.now();
    for (const [id, v] of pendingVerifications.entries()) {
        if (now > v.expiresAt && v.status === "pending") pendingVerifications.delete(id);
    }
}, 5 * 60 * 1000);

/**
 * GET /api/nid/lookup/:nidNumber
 * Validates NID format — full CBS lookup requires accountNumber context.
 */
const lookupNID = async (req, res) => {
    try {
        const { nidNumber } = req.params;

        if (!nidNumber) {
            return res.status(400).json({ success: false, message: "NID number is required" });
        }

        const cleaned = nidNumber.replace(/\D/g, "");
        if (!validateNIDFormat(cleaned)) {
            return res.status(400).json({ success: false, message: "Invalid NID format. Must be 10 or 17 digits." });
        }

        res.json({
            success: true,
            data: {
                found: true,
                nidNumber: cleaned,
                message: "NID format valid. Full verification requires account context.",
            },
        });
    } catch (error) {
        console.error("NID Lookup Error:", error);
        res.status(500).json({ success: false, message: error.message || "Failed to lookup NID" });
    }
};

/**
 * POST /api/nid/verify/initiate
 * Verifies NID against CBS record for the given accountNumber.
 */
const initiateVerification = async (req, res) => {
    try {
        const { nidNumber, customerName, accountNumber } = req.body;

        if (!nidNumber || !accountNumber) {
            return res.status(400).json({
                success: false,
                message: "NID number and account number are required",
            });
        }

        const cleaned = nidNumber.replace(/\D/g, "");
        if (!validateNIDFormat(cleaned)) {
            return res.status(400).json({ success: false, message: "Invalid NID format" });
        }

        // Fetch account details from CBS
        const detail = await cbsService.getCustomerByAccountNumber(accountNumber);
        if (!detail) {
            return res.status(404).json({ success: false, message: "Account not found in CBS" });
        }

        const storedNid = (detail.nidNumber || "").replace(/\D/g, "");
        const nidMatched = storedNid === cleaned;

        if (!nidMatched) {
            return res.status(400).json({
                success: false,
                message: "NID number does not match our records",
            });
        }

        // Attempt to get CBS photo for face match step
        let cbsPhotoBase64 = null;
        try {
            cbsPhotoBase64 = await cbsService.getCustomerPhoto(accountNumber);
        } catch (photoErr) {
            console.warn("[NID] CBS photo unavailable:", photoErr.message);
        }

        const verificationId = generateVerificationId();
        pendingVerifications.set(verificationId, {
            nidNumber: cleaned,
            accountNumber,
            customerName: detail.name,
            cbsPhotoBase64,
            status: "pending",
            nidMatched: true,
            faceMatched: false,
            faceMatchScore: null,
            expiresAt: Date.now() + 10 * 60 * 1000,
            createdAt: Date.now(),
        });

        res.json({
            success: true,
            data: {
                verificationId,
                nidNumber: cleaned,
                nidName: detail.name,
                dateOfBirth: detail.dateOfBirth,
                nidMatched: true,
                requiresFaceMatch: cbsPhotoBase64 !== null,
                hasCbsPhoto: cbsPhotoBase64 !== null,
                expiresIn: 600,
            },
        });
    } catch (error) {
        console.error("NID Verification Initiation Error:", error);
        res.status(400).json({ success: false, message: error.message || "Failed to initiate verification" });
    }
};

/**
 * POST /api/nid/verify/face
 * Compare captured image against CBS stored photo via OpenCV.
 */
const submitFaceMatch = async (req, res) => {
    try {
        const { verificationId, capturedImagePath } = req.body;

        if (!verificationId) {
            return res.status(400).json({ success: false, message: "Verification ID is required" });
        }

        const verification = pendingVerifications.get(verificationId);
        if (!verification) {
            return res.status(400).json({ success: false, message: "Invalid or expired verification session" });
        }

        if (Date.now() > verification.expiresAt) {
            pendingVerifications.delete(verificationId);
            return res.status(400).json({ success: false, message: "Verification session has expired" });
        }

        if (!verification.cbsPhotoBase64) {
            // CBS photo not yet available — skip face match step
            verification.faceMatched = true;
            verification.faceMatchScore = null;
            return res.json({
                success: true,
                data: {
                    verificationId,
                    faceMatched: true,
                    faceMatchScore: null,
                    note: "CBS photo unavailable — face match skipped",
                },
            });
        }

        const opencvRes = await axios.post(
            `${OPENCV_SERVICE_URL}/compare`,
            {
                image1: `data:image/jpeg;base64,${verification.cbsPhotoBase64}`,
                image2: capturedImagePath,
            },
            { timeout: 15000 }
        );

        const { matched, similarity, confidence } = opencvRes.data;

        verification.faceMatched = matched;
        verification.faceMatchScore = similarity;

        res.json({
            success: true,
            data: {
                verificationId,
                faceMatched: matched,
                faceMatchScore: similarity,
                confidence,
            },
        });
    } catch (error) {
        console.error("Face Match Submission Error:", error);
        res.status(400).json({ success: false, message: error.message || "Failed to submit face match" });
    }
};

/**
 * POST /api/nid/verify/complete
 */
const completeVerification = async (req, res) => {
    try {
        const { verificationId } = req.body;

        if (!verificationId) {
            return res.status(400).json({ success: false, message: "Verification ID is required" });
        }

        const verification = pendingVerifications.get(verificationId);
        if (!verification) {
            return res.status(400).json({ success: false, message: "Invalid or expired verification session" });
        }

        if (Date.now() > verification.expiresAt) {
            pendingVerifications.delete(verificationId);
            return res.status(400).json({ success: false, message: "Verification session has expired" });
        }

        const isVerified = verification.nidMatched && verification.faceMatched;
        verification.status = isVerified ? "verified" : "failed";
        verification.completedAt = Date.now();

        const referenceNumber = `REF${Date.now().toString(36).toUpperCase()}`;

        const result = {
            verificationId,
            referenceNumber,
            isVerified,
            nidNumber: verification.nidNumber,
            accountNumber: verification.accountNumber,
            customerName: verification.customerName,
            nidMatched: verification.nidMatched,
            faceMatched: verification.faceMatched,
            faceMatchScore: verification.faceMatchScore,
            status: verification.status,
            completedAt: new Date().toISOString(),
        };

        setTimeout(() => pendingVerifications.delete(verificationId), 60000);

        res.json({ success: true, data: result });
    } catch (error) {
        console.error("Verification Completion Error:", error);
        res.status(400).json({ success: false, message: error.message || "Failed to complete verification" });
    }
};

/**
 * GET /api/nid/verify/status/:verificationId
 */
const getVerificationStatus = async (req, res) => {
    try {
        const { verificationId } = req.params;

        if (!verificationId) {
            return res.status(400).json({ success: false, message: "Verification ID is required" });
        }

        const verification = pendingVerifications.get(verificationId);
        if (!verification) {
            return res.status(404).json({ success: false, message: "Verification not found" });
        }

        res.json({
            success: true,
            data: {
                verificationId,
                status: verification.status,
                nidMatched: verification.nidMatched,
                faceMatched: verification.faceMatched,
                expiresAt: verification.expiresAt,
                isExpired: Date.now() > verification.expiresAt,
            },
        });
    } catch (error) {
        console.error("Get Verification Status Error:", error);
        res.status(500).json({ success: false, message: error.message || "Failed to get verification status" });
    }
};

module.exports = {
    lookupNID,
    initiateVerification,
    submitFaceMatch,
    completeVerification,
    getVerificationStatus,
};
