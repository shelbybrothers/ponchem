// DoH transport for the local tools (tools/rpc-local.mjs and friends).
// The implementation lives in api/_doh.mjs so the deployed proxy and the tools
// share one copy: Vercel does not upload /lib, so the API cannot import from here.
export { looksLikeDnsFailure, resolve, postJson } from '../api/_doh.mjs';
