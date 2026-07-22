/**
 * RSA decryption helper for inbound external-system handshakes (e.g. MTB Neo SSO).
 * Complements encryption.js (which is symmetric AES-256-GCM for at-rest PII) —
 * this is asymmetric, for verifying/decrypting payloads an external party
 * encrypted with a public key we (or they) generated.
 *
 * Private key is read from MTB_NEO_RSA_PRIVATE_KEY (PEM, PKCS1 or PKCS8).
 * For UAT this is a throwaway keypair we generate ourselves; in production
 * MTB replaces the env var value with their real key material — no code change.
 */

const crypto = require('crypto');

const getPrivateKey = () => {
  const key = process.env.MTB_NEO_RSA_PRIVATE_KEY;
  if (!key) {
    throw new Error('MTB_NEO_RSA_PRIVATE_KEY environment variable is required');
  }
  // .env files can't hold real newlines in a PEM block — allow \n-escaped storage.
  return key.includes('\\n') ? key.replace(/\\n/g, '\n') : key;
};

/**
 * Decrypt a single RSA-encrypted, base64-encoded value.
 * @param {string} base64Ciphertext
 * @returns {string} plaintext
 */
const rsaDecrypt = (base64Ciphertext) => {
  const privateKey = getPrivateKey();
  const buffer = Buffer.from(base64Ciphertext, 'base64');

  const decrypted = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    buffer
  );

  return decrypted.toString('utf8');
};

/**
 * Generate a throwaway RSA keypair for UAT/dev testing.
 * Not used at runtime by the app — a one-off script invokes this to produce
 * the keypair; the private key half goes into the k8s Secret, the public
 * key half is used to encrypt test payloads.
 */
const generateKeyPair = () => {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
};

module.exports = {
  rsaDecrypt,
  generateKeyPair,
};
