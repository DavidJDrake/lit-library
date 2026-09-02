// CloudFront Function (JS 2.0) attached to the DEFAULT viewer-request behavior
// only. CloudFront matches path patterns against the raw request URI while S3
// decodes the URI before resolving the object key, so an encoded or
// otherwise-mangled path (e.g. `/catalog%2Ejson`, `//catalog.json`,
// `/./catalog.json`, `/covers%2Fx.webp`) can miss the gated `/catalog.json`
// and `/covers/*` behaviors yet still resolve to the gated objects through
// the ungated default behavior. This function normalizes the path the same
// way and blocks anything that would otherwise reach a gated object.
export const GATE_GUARD_CODE = `
function handler(event) {
  var uri = event.request.uri;
  var decoded = uri;
  try {
    for (var i = 0; i < 3; i++) { var d = decodeURIComponent(decoded); if (d === decoded) break; decoded = d; }
  } catch (e) { return { statusCode: 400, statusDescription: 'Bad Request' }; }
  decoded = decoded.replace(/\\/+/g, '/').replace(/\\/\\.(\\/|$)/g, '/');
  if (decoded === '/catalog.json' || decoded.indexOf('/covers/') === 0) {
    return { statusCode: 403, statusDescription: 'Forbidden' };
  }
  return event.request;
}
`;
