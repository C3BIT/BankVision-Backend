const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const s3Client = require('../configs/s3Client');

const BUCKET = process.env.MINIO_BUCKET || 'bankvision-mtb-ext';
// Presigned URLs expire after 1 hour — sufficient for a manager session
const EXPIRES_IN = 3600;

/**
 * GET /api/forms/download?key=forms/form_...pdf
 * Generates a presigned S3 URL and redirects the browser to it.
 * Requires manager or admin JWT (handled by route middleware).
 */
const downloadForm = async (req, res) => {
  const { key } = req.query;

  if (!key || typeof key !== 'string' || !key.startsWith('forms/')) {
    return res.status(400).json({ success: false, message: 'Invalid or missing key' });
  }

  try {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
    const url = await getSignedUrl(s3Client, command, { expiresIn: EXPIRES_IN });
    return res.redirect(302, url);
  } catch (err) {
    console.error('Failed to generate presigned URL:', err.message);
    return res.status(500).json({ success: false, message: 'Could not generate download link' });
  }
};

module.exports = { downloadForm };
