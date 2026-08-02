// The live video call is independent of CBS data enrichment (accounts, cards,
// loans, profile image). A CBS outage — middleware down, contract mismatch
// (e.g. prod requiring a field UAT didn't), or timeout — must degrade the
// manager's customer sidebar to "unavailable", NOT 500 the request and break
// the call in progress.
//
// An error is treated as an upstream CBS failure when it carries no explicit
// client-side (4xx) status. Validation errors thrown by the controllers set
// `status` to a 4xx code and are deliberately NOT swallowed here — they still
// surface to the client via errorResponseHandler.
const isCbsUpstreamError = (err) => {
  const status = err?.status ?? err?.response?.status;
  return !status || status >= 500;
};

module.exports = { isCbsUpstreamError };
