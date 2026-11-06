export const MAX_URL_LENGTH = 2048;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// Returns { ok: true, url } with the normalized URL, or { ok: false, error }.
// baseUrl is the app's own public URL; links pointing back at it are rejected.
export function validateUrl(input, baseUrl) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, error: 'A "url" string is required' };
  }
  const raw = input.trim();
  if (raw.length > MAX_URL_LENGTH) {
    return { ok: false, error: `URL must be at most ${MAX_URL_LENGTH} characters` };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: 'URL is not valid' };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, error: 'Only http and https URLs are allowed' };
  }
  if (!parsed.hostname) {
    return { ok: false, error: 'URL must include a hostname' };
  }

  const ownHost = new URL(baseUrl).hostname.toLowerCase();
  if (parsed.hostname.toLowerCase() === ownHost) {
    return { ok: false, error: 'Cannot shorten a link to this service' };
  }

  return { ok: true, url: parsed.href };
}
