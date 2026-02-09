/**
 * Field-Level Encryption Utility - Encrypt sensitive PII data at rest
 * Uses AES-256-GCM encryption with environment-based encryption keys
 *
 * IMPORTANT: Set ENCRYPTION_KEY in .env file (32 bytes base64)
 * Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

const crypto = require('crypto');

// Encryption algorithm (AES-256-GCM provides authenticated encryption)
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // Initialization vector length
const AUTH_TAG_LENGTH = 16; // Authentication tag length
const SALT_LENGTH = 32; // Salt length for key derivation

/**
 * Get encryption key from environment
 * @returns {Buffer} - Encryption key
 */
const getEncryptionKey = () => {
  const keyBase64 = process.env.ENCRYPTION_KEY;

  if (!keyBase64) {
    console.warn('⚠️ WARNING: ENCRYPTION_KEY not set in environment. Using default key (INSECURE!)');
    // Fallback to default key (ONLY for development)
    return Buffer.from('default-insecure-key-change-me-in-production!!'); // 32 bytes
  }

  try {
    const key = Buffer.from(keyBase64, 'base64');

    if (key.length !== 32) {
      throw new Error('Encryption key must be 32 bytes (256 bits)');
    }

    return key;
  } catch (error) {
    console.error('Invalid ENCRYPTION_KEY format:', error.message);
    throw new Error('Failed to load encryption key');
  }
};

/**
 * Encrypt a string value
 * @param {string} plaintext - Value to encrypt
 * @returns {string} - Encrypted value (base64 encoded: iv:authTag:ciphertext)
 */
const encrypt = (plaintext) => {
  try {
    if (!plaintext) {
      return null;
    }

    const key = getEncryptionKey();

    // Generate random IV (Initialization Vector)
    const iv = crypto.randomBytes(IV_LENGTH);

    // Create cipher
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    // Encrypt
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    // Get authentication tag
    const authTag = cipher.getAuthTag();

    // Combine IV, auth tag, and encrypted data
    // Format: iv:authTag:ciphertext (all base64 encoded)
    const combined = `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;

    return combined;
  } catch (error) {
    console.error('Encryption error:', error);
    throw new Error('Encryption failed');
  }
};

/**
 * Decrypt an encrypted value
 * @param {string} encrypted - Encrypted value (format: iv:authTag:ciphertext)
 * @returns {string} - Decrypted plaintext
 */
const decrypt = (encrypted) => {
  try {
    if (!encrypted) {
      return null;
    }

    const key = getEncryptionKey();

    // Split combined string
    const parts = encrypted.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }

    const iv = Buffer.from(parts[0], 'base64');
    const authTag = Buffer.from(parts[1], 'base64');
    const ciphertext = parts[2];

    // Create decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    // Decrypt
    let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error);
    throw new Error('Decryption failed');
  }
};

/**
 * Hash a value (one-way, for searching encrypted fields)
 * @param {string} value - Value to hash
 * @returns {string} - SHA-256 hash (hex)
 */
const hashValue = (value) => {
  try {
    if (!value) {
      return null;
    }

    // Use HMAC with secret key for additional security
    const key = getEncryptionKey();
    const hmac = crypto.createHmac('sha256', key);
    hmac.update(value);

    return hmac.digest('hex');
  } catch (error) {
    console.error('Hashing error:', error);
    throw new Error('Hashing failed');
  }
};

/**
 * Encrypt PII fields in an object
 * @param {object} data - Object containing PII fields
 * @param {array} fields - Array of field names to encrypt
 * @returns {object} - Object with encrypted fields
 */
const encryptPII = (data, fields = []) => {
  const encrypted = { ...data };

  for (const field of fields) {
    if (encrypted[field]) {
      encrypted[field] = encrypt(encrypted[field]);

      // Store hash for searching (optional)
      encrypted[`${field}_hash`] = hashValue(data[field]);
    }
  }

  return encrypted;
};

/**
 * Decrypt PII fields in an object
 * @param {object} data - Object with encrypted PII fields
 * @param {array} fields - Array of field names to decrypt
 * @returns {object} - Object with decrypted fields
 */
const decryptPII = (data, fields = []) => {
  const decrypted = { ...data };

  for (const field of fields) {
    if (decrypted[field]) {
      try {
        decrypted[field] = decrypt(decrypted[field]);
      } catch (error) {
        console.error(`Failed to decrypt field ${field}:`, error.message);
        // Leave encrypted if decryption fails
      }
    }
  }

  return decrypted;
};

/**
 * Validate encryption key strength
 * @returns {boolean} - True if encryption key is properly configured
 */
const validateEncryptionKey = () => {
  try {
    const keyBase64 = process.env.ENCRYPTION_KEY;

    if (!keyBase64) {
      console.warn('⚠️ ENCRYPTION_KEY not set - using insecure default');
      return false;
    }

    const key = Buffer.from(keyBase64, 'base64');

    if (key.length !== 32) {
      console.error('❌ ENCRYPTION_KEY must be 32 bytes (256 bits)');
      return false;
    }

    console.log('✅ Encryption key properly configured (AES-256-GCM)');
    return true;
  } catch (error) {
    console.error('❌ Encryption key validation failed:', error.message);
    return false;
  }
};

module.exports = {
  encrypt,
  decrypt,
  hashValue,
  encryptPII,
  decryptPII,
  validateEncryptionKey
};
