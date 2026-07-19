const axios = require("axios");
const crypto = require("crypto");
const { OPENCV_SERVICE_URL } = require("../configs/variables");
const cbsService = require("../services/cbsRealService");
const { redisClient } = require("../configs/redis");

// Redis-backed sessions — must be shared across core-api replicas, since a
// customer's initiate/face-match/complete steps within one verification
// flow can each land on a different pod. Redis TTL replaces the old manual
// interval-based sweep.
const NID_PREFIX = "nid:verification:";

const getVerification = async (id) => {
    const raw = await redisClient.get(NID_PREFIX + id);
    return raw ? JSON.parse(raw) : null;
};
const setVerification = async (id, data, ttlMs) => {
    await redisClient.set(NID_PREFIX + id, JSON.stringify(data), "PX", ttlMs);
};
const deleteVerification = async (id) => {
    await redisClient.del(NID_PREFIX + id);
};

const generateVerificationId = () =>
    `NID_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

const validateNIDFormat = (nidNumber) => {
    const cleaned = nidNumber.replace(/\D/g, "");
    return cleaned.length === 10 || cleaned.length === 17;
};

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
        const verificationTtlMs = 10 * 60 * 1000;
        await setVerification(verificationId, {
            nidNumber: cleaned,
            accountNumber,
            customerName: detail.name,
            cbsPhotoBase64,
            status: "pending",
            nidMatched: true,
            faceMatched: false,
            faceMatchScore: null,
            expiresAt: Date.now() + verificationTtlMs,
            createdAt: Date.now(),
        }, verificationTtlMs);

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

        const verification = await getVerification(verificationId);
        if (!verification) {
            return res.status(400).json({ success: false, message: "Invalid or expired verification session" });
        }

        if (Date.now() > verification.expiresAt) {
            await deleteVerification(verificationId);
            return res.status(400).json({ success: false, message: "Verification session has expired" });
        }

        if (!verification.cbsPhotoBase64) {
            // CBS photo not yet available — skip face match step
            verification.faceMatched = true;
            verification.faceMatchScore = null;
            await setVerification(verificationId, verification, Math.max(1000, verification.expiresAt - Date.now()));
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
        await setVerification(verificationId, verification, Math.max(1000, verification.expiresAt - Date.now()));

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

        const verification = await getVerification(verificationId);
        if (!verification) {
            return res.status(400).json({ success: false, message: "Invalid or expired verification session" });
        }

        if (Date.now() > verification.expiresAt) {
            await deleteVerification(verificationId);
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

        // Keep the completed record readable via getVerificationStatus for 60s
        // (was setTimeout+delete against the in-memory Map), then let it expire.
        await setVerification(verificationId, verification, 60000);

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

        const verification = await getVerification(verificationId);
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
