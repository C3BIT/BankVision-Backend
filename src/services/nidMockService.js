/**
 * NID Mock Service
 * Simulates National ID verification API middleware pattern
 *
 * In production, this would connect to actual NID verification services.
 * This mock simulates the verification process for testing purposes.
 */

const crypto = require("crypto");
const { RANDOM_USER_API_URL } = require("../configs/variables");

// Mock NID database for testing
const mockNIDDatabase = {
  "1234567890": {
    name: "John Doe",
    fatherName: "James Doe",
    motherName: "Jane Doe",
    dateOfBirth: "1985-05-15",
    permanentAddress: "123 Main Street, Dhaka, Bangladesh",
    presentAddress: "456 Oak Avenue, Dhaka, Bangladesh",
    bloodGroup: "O+",
    photo: `${RANDOM_USER_API_URL}men/1.jpg`,
    nidNumber: "1234567890",
    issuedDate: "2010-01-20",
    status: "valid"
  },
  "0987654321": {
    name: "Jane Smith",
    fatherName: "Robert Smith",
    motherName: "Mary Smith",
    dateOfBirth: "1990-08-22",
    permanentAddress: "789 Pine Road, Chittagong, Bangladesh",
    presentAddress: "321 Elm Street, Chittagong, Bangladesh",
    bloodGroup: "A+",
    photo: `${RANDOM_USER_API_URL}women/1.jpg`,
    nidNumber: "0987654321",
    issuedDate: "2015-06-10",
    status: "valid"
  },
  "5555555555": {
    name: "Test User",
    fatherName: "Test Father",
    motherName: "Test Mother",
    dateOfBirth: "1988-03-10",
    permanentAddress: "555 Test Street, Sylhet, Bangladesh",
    presentAddress: "555 Test Street, Sylhet, Bangladesh",
    bloodGroup: "B+",
    photo: `${RANDOM_USER_API_URL}men/2.jpg`,
    nidNumber: "5555555555",
    issuedDate: "2012-09-05",
    status: "valid"
  },
  "1111111111": {
    name: "Expired User",
    fatherName: "Expired Father",
    motherName: "Expired Mother",
    dateOfBirth: "1970-01-01",
    permanentAddress: "111 Old Street, Khulna, Bangladesh",
    presentAddress: "111 Old Street, Khulna, Bangladesh",
    bloodGroup: "AB-",
    photo: `${RANDOM_USER_API_URL}men/3.jpg`,
    nidNumber: "1111111111",
    issuedDate: "2005-01-01",
    status: "expired"
  }
};

// Pending verification requests
const pendingVerifications = new Map();

/**
 * Generate verification request ID
 */
const generateVerificationId = () => {
  return `NID_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
};

/**
 * Verify NID number format
 * @param {string} nidNumber - NID number to validate
 */
const validateNIDFormat = (nidNumber) => {
  // Bangladesh NID is either 10 or 17 digits
  const cleaned = nidNumber.replace(/\D/g, "");
  return cleaned.length === 10 || cleaned.length === 17;
};

/**
 * Lookup NID information
 * GET /mock/nid/lookup
 *
 * @param {string} nidNumber - NID number to lookup
 */
const lookupNID = async (nidNumber) => {
  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 500));

  const cleanedNID = nidNumber.replace(/\D/g, "");

  if (!validateNIDFormat(cleanedNID)) {
    return {
      found: false,
      error: "Invalid NID format. Must be 10 or 17 digits."
    };
  }

  const nidData = mockNIDDatabase[cleanedNID];

  if (!nidData) {
    // For testing, generate mock data for unknown NIDs
    if (cleanedNID.length >= 10) {
      return {
        found: true,
        nidNumber: cleanedNID,
        name: `Customer ${cleanedNID.substring(0, 4)}`,
        fatherName: "Father Name",
        motherName: "Mother Name",
        dateOfBirth: "1990-01-01",
        permanentAddress: "Mock Address, Bangladesh",
        presentAddress: "Mock Address, Bangladesh",
        bloodGroup: "O+",
        photo: `${RANDOM_USER_API_URL}men/${parseInt(cleanedNID.substring(0, 2)) % 100}.jpg`,
        issuedDate: "2015-01-01",
        status: "valid"
      };
    }
    return {
      found: false,
      error: "NID not found in database"
    };
  }

  return {
    found: true,
    ...nidData
  };
};

/**
 * Initiate NID verification with face match
 * POST /mock/nid/verify/initiate
 *
 * @param {string} nidNumber - NID number
 * @param {string} customerName - Customer name to match
 * @param {string} accountNumber - Bank account number for reference
 */
const initiateVerification = async (nidNumber, customerName, accountNumber) => {
  const cleanedNID = nidNumber.replace(/\D/g, "");

  if (!validateNIDFormat(cleanedNID)) {
    throw new Error("Invalid NID format");
  }

  const nidData = await lookupNID(nidNumber);

  if (!nidData.found) {
    throw new Error(nidData.error || "NID not found");
  }

  if (nidData.status === "expired") {
    throw new Error("NID has expired. Please renew your NID.");
  }

  const verificationId = generateVerificationId();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  pendingVerifications.set(verificationId, {
    nidNumber: cleanedNID,
    nidData,
    customerName,
    accountNumber,
    expiresAt,
    status: "pending",
    faceMatched: false,
    nameMatched: false,
    createdAt: Date.now()
  });

  // Name matching (simple comparison, case-insensitive)
  const nameSimilarity = calculateNameSimilarity(customerName, nidData.name);
  const nameMatched = nameSimilarity >= 0.7;

  pendingVerifications.get(verificationId).nameMatched = nameMatched;
  pendingVerifications.get(verificationId).nameSimilarity = nameSimilarity;

  return {
    verificationId,
    nidNumber: cleanedNID,
    nidName: nidData.name,
    nidPhoto: nidData.photo,
    dateOfBirth: nidData.dateOfBirth,
    nameMatched,
    nameSimilarity: Math.round(nameSimilarity * 100),
    requiresFaceMatch: true,
    expiresIn: 600 // seconds
  };
};

/**
 * Calculate name similarity (simple Levenshtein-based)
 */
const calculateNameSimilarity = (name1, name2) => {
  const s1 = name1.toLowerCase().trim();
  const s2 = name2.toLowerCase().trim();

  if (s1 === s2) return 1;

  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;

  if (longer.length === 0) return 1;

  // Simple character matching
  let matches = 0;
  const shorterChars = shorter.split("");
  const longerChars = longer.split("");

  shorterChars.forEach(char => {
    const idx = longerChars.indexOf(char);
    if (idx !== -1) {
      matches++;
      longerChars.splice(idx, 1);
    }
  });

  return matches / longer.length;
};

/**
 * Submit face match result
 * POST /mock/nid/verify/face
 *
 * @param {string} verificationId - Verification session ID
 * @param {string} capturedImagePath - Path to captured image
 * @param {number} matchScore - Face match score (0-100)
 */
const submitFaceMatch = async (verificationId, capturedImagePath, matchScore = null) => {
  const verification = pendingVerifications.get(verificationId);

  if (!verification) {
    throw new Error("Invalid or expired verification session");
  }

  if (Date.now() > verification.expiresAt) {
    pendingVerifications.delete(verificationId);
    throw new Error("Verification session has expired");
  }

  // Mock face match score if not provided
  // In production, this would use actual face recognition API
  const faceMatchScore = matchScore !== null ? matchScore : Math.floor(70 + Math.random() * 25);

  verification.faceMatched = faceMatchScore >= 70;
  verification.faceMatchScore = faceMatchScore;
  verification.capturedImagePath = capturedImagePath;

  return {
    verificationId,
    faceMatched: verification.faceMatched,
    faceMatchScore,
    nameMatched: verification.nameMatched,
    nameSimilarity: verification.nameSimilarity
  };
};

/**
 * Complete NID verification
 * POST /mock/nid/verify/complete
 *
 * @param {string} verificationId - Verification session ID
 */
const completeVerification = async (verificationId) => {
  const verification = pendingVerifications.get(verificationId);

  if (!verification) {
    throw new Error("Invalid or expired verification session");
  }

  if (Date.now() > verification.expiresAt) {
    pendingVerifications.delete(verificationId);
    throw new Error("Verification session has expired");
  }

  const isVerified = verification.nameMatched && verification.faceMatched;

  verification.status = isVerified ? "verified" : "failed";
  verification.completedAt = Date.now();

  // Generate verification reference
  const referenceNumber = `REF${Date.now().toString(36).toUpperCase()}`;

  const result = {
    verificationId,
    referenceNumber,
    isVerified,
    nidNumber: verification.nidNumber,
    accountNumber: verification.accountNumber,
    customerName: verification.customerName,
    nidName: verification.nidData.name,
    nameMatched: verification.nameMatched,
    nameSimilarity: Math.round(verification.nameSimilarity * 100),
    faceMatched: verification.faceMatched,
    faceMatchScore: verification.faceMatchScore,
    status: verification.status,
    completedAt: new Date().toISOString()
  };

  // Clean up after returning result
  setTimeout(() => pendingVerifications.delete(verificationId), 60000);

  return result;
};

/**
 * Get verification status
 * GET /mock/nid/verify/status/:verificationId
 */
const getVerificationStatus = (verificationId) => {
  const verification = pendingVerifications.get(verificationId);

  if (!verification) {
    return {
      found: false,
      error: "Verification not found"
    };
  }

  return {
    found: true,
    verificationId,
    status: verification.status,
    nameMatched: verification.nameMatched,
    faceMatched: verification.faceMatched,
    expiresAt: verification.expiresAt,
    isExpired: Date.now() > verification.expiresAt
  };
};

/**
 * Clean up expired verifications
 */
const cleanupExpiredVerifications = () => {
  const now = Date.now();
  for (const [verificationId, verification] of pendingVerifications.entries()) {
    if (now > verification.expiresAt && verification.status === "pending") {
      pendingVerifications.delete(verificationId);
    }
  }
};

// Run cleanup every 5 minutes
setInterval(cleanupExpiredVerifications, 5 * 60 * 1000);

module.exports = {
  validateNIDFormat,
  lookupNID,
  initiateVerification,
  submitFaceMatch,
  completeVerification,
  getVerificationStatus
};
