// Verifies file content against known magic-byte signatures instead of trusting
// the client-supplied Content-Type, which is trivially spoofable (e.g. an SVG
// with a spoofed "image/png" Content-Type was accepted and later served inline,
// executing embedded <script> content).

const SIGNATURES = {
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/gif": [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  ],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]], // "RIFF"; WEBP marker follows at byte 8
};

const MIME_EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

const matchesSignature = (buffer, signature) =>
  signature.every((byte, i) => buffer[i] === byte);

const matchesMimeType = (buffer, mimetype) => {
  if (mimetype === "application/pdf") {
    return buffer.slice(0, 4).toString("ascii") === "%PDF";
  }
  const signatures = SIGNATURES[mimetype];
  if (!signatures) return false;
  if (mimetype === "image/webp") {
    return (
      matchesSignature(buffer, signatures[0]) &&
      buffer.slice(8, 12).toString("ascii") === "WEBP"
    );
  }
  return signatures.some((signature) => matchesSignature(buffer, signature));
};

const extensionForMimeType = (mimetype) => MIME_EXTENSIONS[mimetype] || "";

module.exports = { matchesMimeType, extensionForMimeType };
