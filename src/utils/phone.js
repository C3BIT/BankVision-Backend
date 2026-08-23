// Canonical customer-identity normalizer.
//
// A customer is keyed either by phone (verified by SMS OTP) or by email
// (verified by email OTP). This function collapses either to the single
// canonical form the rest of the platform compares and embeds:
//   - phone  -> BD-canonical `01XXXXXXXXX` (country code stripped, leading 0)
//   - email  -> lowercased address (NOT stripped to digits)
//
// It lives here — rather than inline in socketHandler.js — so that the two
// places that must agree on a customer's identity can never drift:
//   1. socketHandler.js, which *builds* the call room name `room_<id>_<ts>`
//   2. openvidu.route.js, which *authorizes* a LiveKit token by requiring the
//      caller's identity to equal that room's `<id>` segment.
// If these used different normalizers, a legitimate customer could be denied a
// media token, or (worse) the authorization check could be loosened to
// compensate. One definition keeps the security boundary exact.
const normalizePhone = (phone) => {
  if (!phone) return null;
  const str = phone.toString().trim();
  // Email-identity customers (verified by email) carry the email as their key.
  // Do NOT strip it to digits — that turned "kibria78@gmail.com" into "78".
  if (str.includes('@')) return str.toLowerCase();
  // Remove all non-numeric characters
  let cleaned = str.replace(/\D/g, '');
  // If it starts with 880 (Bangladesh country code), remove it
  if (cleaned.startsWith('880') && cleaned.length > 10) {
    cleaned = cleaned.substring(3);
  }
  // Ensure it starts with 0 for BD consistency (01XXXXX)
  if (cleaned.startsWith('1') && cleaned.length === 10) {
    cleaned = '0' + cleaned;
  }
  return cleaned;
};

module.exports = { normalizePhone };
