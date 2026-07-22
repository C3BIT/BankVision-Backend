// Transparent Base64 encode/decode layer for JSON API request/response bodies.
// TLS already provides the real confidentiality on the wire; this is an
// additional obfuscation layer applied at the client's request so raw JSON
// never appears verbatim in request/response bodies. It sits in front of
// req.body and wraps res.json/res.send so controllers stay unaware of it.
//
// Contract: client sends the JSON-stringified body Base64-encoded as raw
// text with `Content-Type: application/base64`. Server responds the same
// way. Requests without that content type (multipart uploads, form posts)
// pass through untouched on the way in, but responses are still encoded so
// the response side of every /api route is consistent.

const EXCLUDED_PATH_PREFIXES = [
  '/webhook', // external systems (LiveKit) POST/expect plain JSON here
  '/dev/health', // infra health checks expect plain JSON
  '/sso', // external systems (MTB Neo) POST/expect plain JSON here
];

const isExcluded = (req) =>
  EXCLUDED_PATH_PREFIXES.some((prefix) => req.path.startsWith(prefix));

const wrapResponse = (res) => {
  const originalSend = res.send.bind(res);

  res.json = (body) => {
    const jsonString = JSON.stringify(body === undefined ? null : body);
    const encoded = Buffer.from(jsonString, 'utf8').toString('base64');
    res.setHeader('Content-Type', 'application/base64; charset=utf-8');
    return originalSend(encoded);
  };

  res.send = (body) => {
    if (typeof body === 'string') {
      const encoded = Buffer.from(body, 'utf8').toString('base64');
      res.setHeader('Content-Type', 'application/base64; charset=utf-8');
      return originalSend(encoded);
    }
    return originalSend(body);
  };
};

const base64Codec = (req, res, next) => {
  if (isExcluded(req)) {
    return next();
  }

  if (!req.is('application/base64')) {
    // Not an encoded request (e.g. multipart file upload) - only wrap the
    // outgoing response so it still leaves in encoded form.
    wrapResponse(res);
    return next();
  }

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    try {
      const decoded = raw ? Buffer.from(raw, 'base64').toString('utf8') : '';
      req.body = decoded ? JSON.parse(decoded) : {};
    } catch (err) {
      wrapResponse(res);
      return res.status(400).json({
        status: 'fail',
        message: 'Invalid Base64-encoded request payload',
        data: null,
        error: {},
      });
    }
    wrapResponse(res);
    next();
  });
};

module.exports = { base64Codec };
